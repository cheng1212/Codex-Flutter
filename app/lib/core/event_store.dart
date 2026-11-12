/// Idempotent event handling for the companion event stream.
///
/// The server assigns a global monotonic `seq` to every event and replays
/// `seq > lastSeq` after a reconnect (docs/protocol.md). Replays can
/// re-deliver events the client already saw, so the client must dedupe by
/// `seq`: a repeated `seq` is processed exactly once.
class EventStore {
  EventStore({int maxTracked = 10000}) : _maxTracked = maxTracked;

  final int _maxTracked;

  /// Highest `seq` applied so far. Sent back as `lastSeq` on subscribe.
  int lastSeq = 0;

  final Set<int> _seen = <int>{};

  /// Returns true when an event with [seq] is new and should be applied,
  /// false when it is a duplicate delivery (or an old event at/below the
  /// watermark) that must be skipped. Out-of-order arrivals are accepted
  /// as long as their `seq` was never seen.
  bool apply(int seq) {
    if (seq <= 0) return false;
    if (_seen.contains(seq)) return false;
    _seen.add(seq);
    if (seq > lastSeq) lastSeq = seq;
    if (_seen.length > _maxTracked) {
      // Drop the oldest tracked seqs; lastSeq (the watermark) still
      // protects against replays of anything at or below it.
      final sorted = _seen.toList()..sort();
      final excess = _seen.length - _maxTracked;
      for (var i = 0; i < excess; i++) {
        _seen.remove(sorted[i]);
      }
    }
    return true;
  }

  /// Restore the watermark after an app restart (persisted separately —
  /// see `SettingsStore.lastSeq`). Events at or below it are skipped.
  void restoreWatermark(int seq) {
    if (seq > lastSeq) lastSeq = seq;
  }

  /// A seq at or below the watermark has already been applied.
  bool isAlreadyApplied(int seq) => seq <= lastSeq || _seen.contains(seq);
}
