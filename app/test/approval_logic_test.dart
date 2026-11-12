import 'package:codex_flutter/core/protocol_models.dart';
import 'package:codex_flutter/features/approvals/approval_logic.dart';
import 'package:flutter_test/flutter_test.dart';

ApprovalRequestedPayload request({
  List<ApprovalDecision> decisions = const [
    ApprovalDecision.accept,
    ApprovalDecision.decline,
  ],
  String? expiresAt,
}) =>
    ApprovalRequestedPayload(
      itemId: 'itm_1',
      threadId: 'thr_1',
      turnId: 'trn_1',
      kind: 'commandExecution',
      availableDecisions: decisions,
      expiresAt: expiresAt == null ? null : DateTime.tryParse(expiresAt),
    );

void main() {
  group('liveDecisions / disabledPersistentDecisions', () {
    test('basic request offers exactly accept + decline', () {
      final r = request();
      expect(liveDecisions(r), [
        ApprovalDecision.accept,
        ApprovalDecision.decline,
      ]);
      expect(disabledPersistentDecisions(r), isEmpty);
    });

    test('extended request: persistent grant is disabled, not live', () {
      final r = request(decisions: const [
        ApprovalDecision.accept,
        ApprovalDecision.acceptForSession,
        ApprovalDecision.decline,
        ApprovalDecision.cancel,
      ]);
      expect(liveDecisions(r), [
        ApprovalDecision.accept,
        ApprovalDecision.decline,
        ApprovalDecision.cancel,
      ]);
      expect(disabledPersistentDecisions(r), [
        ApprovalDecision.acceptForSession,
      ]);
    });

    test('a request offering only a persistent grant has no live buttons', () {
      final r = request(decisions: const [
        ApprovalDecision.acceptForSession,
      ]);
      expect(liveDecisions(r), isEmpty);
      expect(disabledPersistentDecisions(r), [
        ApprovalDecision.acceptForSession,
      ]);
    });

    test('never invents decisions the server did not offer', () {
      final r = request(decisions: const [ApprovalDecision.decline]);
      expect(liveDecisions(r), [ApprovalDecision.decline]);
    });
  });

  group('isAnswerable', () {
    test('fresh request while connected is answerable', () {
      expect(
        isAnswerable(request: request(), resolved: null, connected: true),
        isTrue,
      );
    });

    test('resolved request is not answerable', () {
      for (final status in ApprovalResolvedStatus.values) {
        expect(
          isAnswerable(
            request: request(),
            resolved: status,
            connected: true,
          ),
          isFalse,
          reason: 'status $status must disable the card',
        );
      }
    });

    test('expired request is not answerable', () {
      final r = request(expiresAt: '2020-01-01T00:00:00.000Z');
      expect(
        isAnswerable(request: r, resolved: null, connected: true),
        isFalse,
      );
      expect(
        invalidReason(request: r, resolved: null, connected: true),
        contains('已过期'),
      );
    });

    test('disconnected client must not answer (server may have cleared it)', () {
      expect(
        isAnswerable(request: request(), resolved: null, connected: false),
        isFalse,
      );
      expect(
        invalidReason(request: request(), resolved: null, connected: false),
        contains('已断连'),
      );
    });

    test('invalidReason names the resolved outcome', () {
      expect(
        invalidReason(
          request: request(),
          resolved: ApprovalResolvedStatus.accepted,
          connected: true,
        ),
        '已批准',
      );
      expect(
        invalidReason(
          request: request(),
          resolved: ApprovalResolvedStatus.expired,
          connected: true,
        ),
        contains('已过期'),
      );
      expect(
        invalidReason(
          request: request(),
          resolved: ApprovalResolvedStatus.cleared,
          connected: true,
        ),
        contains('已失效'),
      );
    });
  });
}
