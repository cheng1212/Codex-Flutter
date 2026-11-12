import '../../core/protocol_models.dart';

/// Approval-card rendering rules (docs/protocol.md, "审批", Issue #1).
///
/// These are pure functions so they can be unit-tested without widgets:
///
/// * `availableDecisions` is the ONLY authority for which buttons exist.
///   The client must never hard-code accept/decline.
/// * Persistent grants (`acceptForSession`,
///   `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`) are
///   blocked server-side by default. When one appears in
///   `availableDecisions` it is rendered disabled/greyed with a note that
///   it needs the server operator to enable it — never as a live button.
/// * A request becomes unanswerable once it is resolved, expired,
///   cancelled, or the client disconnects. Expired/cancelled requests
///   render as "已失效" with no clickable buttons.

/// The decisions the UI may offer as live buttons for [request].
/// Persistent grants are excluded here: they are shown disabled, not live.
List<ApprovalDecision> liveDecisions(ApprovalRequestedPayload request) {
  return request.availableDecisions
      .where((d) => !d.isPersistentGrant)
      .toList(growable: false);
}

/// Persistent grants present in the request, shown disabled with a note.
List<ApprovalDecision> disabledPersistentDecisions(
  ApprovalRequestedPayload request,
) {
  return request.availableDecisions
      .where((d) => d.isPersistentGrant)
      .toList(growable: false);
}

/// Whether the request can still be answered right now.
///
/// [resolved] is the `approval.resolved` status received for this item,
/// if any. [connected] is the current WebSocket state: the server clears
/// any still-pending approval when the last viewer of a session
/// disconnects (`server/src/server.ts`, `onClose`), so a disconnected
/// client must not offer buttons for a request that may already be dead.
bool isAnswerable({
  required ApprovalRequestedPayload request,
  ApprovalResolvedStatus? resolved,
  required bool connected,
}) {
  if (resolved != null) return false;
  if (request.isExpired) return false;
  if (!connected) return false;
  return true;
}

/// Human-readable status line for a request that can no longer be answered.
String invalidReason({
  ApprovalRequestedPayload? request,
  ApprovalResolvedStatus? resolved,
  required bool connected,
}) {
  if (resolved != null) {
    switch (resolved) {
      case ApprovalResolvedStatus.accepted:
        return '已批准';
      case ApprovalResolvedStatus.declined:
        return '已拒绝';
      case ApprovalResolvedStatus.cancelled:
        return '已取消';
      case ApprovalResolvedStatus.expired:
        return '已过期，无法操作';
      case ApprovalResolvedStatus.cleared:
        return '已失效（会话结束或已断连）';
    }
  }
  if (request != null && request.isExpired) return '已过期，无法操作';
  if (!connected) return '已断连，待重连后查看最新状态';
  return '已失效';
}
