import 'package:codex_flutter/core/event_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('EventStore', () {
    test('first delivery of a seq is applied', () {
      final store = EventStore();
      expect(store.apply(1), isTrue);
      expect(store.lastSeq, 1);
    });

    test('a repeated seq is skipped (replay dedup)', () {
      final store = EventStore();
      expect(store.apply(4), isTrue);
      expect(store.apply(4), isFalse);
      expect(store.apply(4), isFalse);
      expect(store.lastSeq, 4);
    });

    test('out-of-order arrivals are accepted once each', () {
      final store = EventStore();
      expect(store.apply(5), isTrue);
      expect(store.apply(3), isTrue); // arrived late, never seen before
      expect(store.apply(3), isFalse);
      expect(store.apply(4), isTrue);
      expect(store.lastSeq, 5);
    });

    test('seq <= 0 is never applied', () {
      final store = EventStore();
      expect(store.apply(0), isFalse);
      expect(store.apply(-2), isFalse);
      expect(store.lastSeq, 0);
    });

    test('restored watermark skips old seqs via isAlreadyApplied', () {
      final store = EventStore();
      store.restoreWatermark(42);
      expect(store.lastSeq, 42);
      expect(store.isAlreadyApplied(42), isTrue);
      expect(store.isAlreadyApplied(10), isTrue);
      expect(store.isAlreadyApplied(43), isFalse);
      // A history event at/below the watermark still applies when it was
      // never seen (snapshot rebuild), but a replayed one does not.
      expect(store.apply(10), isTrue);
      expect(store.apply(10), isFalse);
    });

    test('bounded tracking still dedupes recent seqs after eviction', () {
      final store = EventStore(maxTracked: 3);
      expect(store.apply(1), isTrue);
      expect(store.apply(2), isTrue);
      expect(store.apply(3), isTrue);
      expect(store.apply(4), isTrue); // evicts seq 1 from the set
      expect(store.apply(4), isFalse); // still in the set
      expect(store.apply(3), isFalse);
      expect(store.lastSeq, 4);
    });
  });
}
