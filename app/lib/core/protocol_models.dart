/// Protocol v1.0.0 models for the Codex-Flutter companion protocol.
///
/// Mirrors `packages/protocol/src/types.ts` and
/// `packages/protocol/schema/protocol.schema.json` by hand (no codegen, so
/// the app has no build_runner dependency).
///
/// Event and command names come only from the Phase 0 capability matrix
/// (`docs/codex-capability-matrix.md` §4) as mapped in `docs/protocol.md`.
/// No invented event or command names. Nothing from the Claude SDK or
/// Claude session protocol is used here.
library;

/// Protocol version carried by every event envelope.
const String kProtocolVersion = '1.0.0';

/// The 13 event types of protocol v1.0.0 (docs/protocol.md).
enum EventType {
  sessionCreated('session.created'),
  sessionStatus('session.status'),
  messageStarted('message.started'),
  messageDelta('message.delta'),
  messageCompleted('message.completed'),
  planUpdated('plan.updated'),
  toolStarted('tool.started'),
  toolOutput('tool.output'),
  toolCompleted('tool.completed'),
  approvalRequested('approval.requested'),
  approvalResolved('approval.resolved'),
  sessionError('session.error'),
  connectionHeartbeat('connection.heartbeat');

  const EventType(this.wireName);
  final String wireName;

  static EventType? fromWireName(String name) {
    for (final value in EventType.values) {
      if (value.wireName == name) return value;
    }
    return null;
  }
}

/// The 5 client commands of protocol v1.0.0 (docs/protocol.md).
enum CommandName {
  sessionCreate('session.create'),
  sessionResume('session.resume'),
  messageSend('message.send'),
  sessionCancel('session.cancel'),
  approvalRespond('approval.respond');

  const CommandName(this.wireName);
  final String wireName;
}

/// Decisions a real app-server approval request may carry (matrix #9/#10).
/// The full set is the wire vocabulary; what the UI may offer is decided
/// per-request by `availableDecisions` — never by this enum.
enum ApprovalDecision {
  accept('accept'),
  acceptForSession('acceptForSession'),
  decline('decline'),
  cancel('cancel'),
  acceptWithExecpolicyAmendment('acceptWithExecpolicyAmendment'),
  applyNetworkPolicyAmendment('applyNetworkPolicyAmendment');

  const ApprovalDecision(this.wireName);
  final String wireName;

  static ApprovalDecision? fromWireName(String name) {
    for (final value in ApprovalDecision.values) {
      if (value.wireName == name) return value;
    }
    return null;
  }

  /// Persistent grants: the companion server rejects them by default
  /// (403 `decision-not-allowed`) unless the operator explicitly enables
  /// `CODEX_FLUTTER_ALLOW_PERSISTENT_APPROVALS=1` after review
  /// (docs/protocol.md, "审批"). The client must never present them as
  /// ordinary one-shot approve/decline buttons.
  bool get isPersistentGrant {
    switch (this) {
      case ApprovalDecision.acceptForSession:
      case ApprovalDecision.acceptWithExecpolicyAmendment:
      case ApprovalDecision.applyNetworkPolicyAmendment:
        return true;
      case ApprovalDecision.accept:
      case ApprovalDecision.decline:
      case ApprovalDecision.cancel:
        return false;
    }
  }

  /// Chinese label shown on the approval card button.
  String get label {
    switch (this) {
      case ApprovalDecision.accept:
        return '批准（本次）';
      case ApprovalDecision.acceptForSession:
        return '本会话都批准';
      case ApprovalDecision.decline:
        return '拒绝';
      case ApprovalDecision.cancel:
        return '取消';
      case ApprovalDecision.acceptWithExecpolicyAmendment:
        return '批准并修改执行策略';
      case ApprovalDecision.applyNetworkPolicyAmendment:
        return '批准并应用网络策略';
    }
  }
}

enum ApprovalResolvedStatus {
  accepted('accepted'),
  declined('declined'),
  cancelled('cancelled'),
  expired('expired'),
  cleared('cleared');

  const ApprovalResolvedStatus(this.wireName);
  final String wireName;

  static ApprovalResolvedStatus? fromWireName(String name) {
    for (final value in ApprovalResolvedStatus.values) {
      if (value.wireName == name) return value;
    }
    return null;
  }
}

/// One server event envelope: protocolVersion, eventId, seq, sessionId,
/// timestamp, type, payload.
class EventEnvelope {
  const EventEnvelope({
    required this.protocolVersion,
    required this.eventId,
    required this.seq,
    required this.sessionId,
    required this.timestamp,
    required this.type,
    required this.payload,
  });

  factory EventEnvelope.fromJson(Map<String, dynamic> json) {
    final type = EventType.fromWireName(json['type'] as String? ?? '');
    if (type == null) {
      throw const FormatException('unknown event type');
    }
    if (json['protocolVersion'] != kProtocolVersion) {
      throw const FormatException('unsupported protocolVersion');
    }
    return EventEnvelope(
      protocolVersion: json['protocolVersion'] as String,
      eventId: json['eventId'] as String? ?? '',
      seq: (json['seq'] as num).toInt(),
      sessionId: json['sessionId'] as String? ?? '',
      timestamp: DateTime.tryParse(json['timestamp'] as String? ?? '') ??
          DateTime.fromMillisecondsSinceEpoch(0),
      type: type,
      payload: (json['payload'] as Map?)?.cast<String, dynamic>() ?? const {},
    );
  }

  final String protocolVersion;
  final String eventId;
  final int seq;
  final String sessionId;
  final DateTime timestamp;
  final EventType type;
  final Map<String, dynamic> payload;

  Map<String, dynamic> toJson() => {
        'protocolVersion': protocolVersion,
        'eventId': eventId,
        'seq': seq,
        'sessionId': sessionId,
        'timestamp': timestamp.toIso8601String(),
        'type': type.wireName,
        'payload': payload,
      };
}

/// Payload of `approval.requested` (see `packages/protocol/schema/`).
class ApprovalRequestedPayload {
  const ApprovalRequestedPayload({
    required this.itemId,
    required this.threadId,
    required this.turnId,
    required this.kind,
    required this.availableDecisions,
    this.reason,
    this.command,
    this.cwd,
    this.networkApprovalContext,
    this.permissions,
    this.expiresAt,
  });

  factory ApprovalRequestedPayload.fromJson(Map<String, dynamic> json) {
    final decisions = (json['availableDecisions'] as List? ?? const [])
        .map((d) => ApprovalDecision.fromWireName(d as String? ?? ''))
        .whereType<ApprovalDecision>()
        .toList();
    final network = json['networkApprovalContext'] as Map?;
    return ApprovalRequestedPayload(
      itemId: json['itemId'] as String? ?? '',
      threadId: json['threadId'] as String? ?? '',
      turnId: json['turnId'] as String? ?? '',
      kind: json['kind'] as String? ?? '',
      availableDecisions: decisions,
      reason: json['reason'] as String?,
      command: json['command'] as String?,
      cwd: json['cwd'] as String?,
      networkApprovalContext: network == null
          ? null
          : NetworkApprovalContext(
              host: network['host'] as String?,
              protocol: network['protocol'] as String?,
            ),
      permissions: (json['permissions'] as List?)
          ?.map((p) => p.toString())
          .toList(),
      expiresAt: json['expiresAt'] == null
          ? null
          : DateTime.tryParse(json['expiresAt'] as String),
    );
  }

  final String itemId;
  final String threadId;
  final String turnId;

  /// `commandExecution`, `fileChange` (matrix #9/#10), or `permissions`
  /// (matrix #11: the `request_permissions` tool asks to grant a subset
  /// of permissions). The `permissions` kind arrived with the Phase 2
  /// real adapter; it is rendered as its own card, never as a command.
  final String kind;

  /// The ONLY authority for which buttons the UI may render.
  final List<ApprovalDecision> availableDecisions;

  final String? reason;
  final String? command;
  final String? cwd;

  /// Present only for controlled-network-access approvals: render
  /// host/protocol separately, never as a plain command (protocol.md).
  final NetworkApprovalContext? networkApprovalContext;

  /// Permissions kind only: one-line summaries of the requested grants
  /// (paths/hosts the user must see to decide).
  final List<String>? permissions;

  /// Server-side expiry (default TTL 15 min). May be absent: the server
  /// also clears the request via `approval.resolved` (expired/cleared),
  /// which is the authoritative invalidation signal.
  final DateTime? expiresAt;

  /// Local expiry check. True only when the server sent an expiry and it
  /// has passed; otherwise the request is live until an
  /// `approval.resolved` event (or disconnect) invalidates it.
  bool get isExpired =>
      expiresAt != null && DateTime.now().isAfter(expiresAt!);
}

class NetworkApprovalContext {
  const NetworkApprovalContext({this.host, this.protocol});
  final String? host;
  final String? protocol;
}

/// Payload of `approval.resolved`.
class ApprovalResolvedPayload {
  const ApprovalResolvedPayload({
    required this.itemId,
    required this.threadId,
    required this.turnId,
    required this.status,
    this.decision,
    this.reason,
  });

  factory ApprovalResolvedPayload.fromJson(Map<String, dynamic> json) {
    return ApprovalResolvedPayload(
      itemId: json['itemId'] as String? ?? '',
      threadId: json['threadId'] as String? ?? '',
      turnId: json['turnId'] as String? ?? '',
      status: ApprovalResolvedStatus.fromWireName(
              json['status'] as String? ?? '') ??
          ApprovalResolvedStatus.cleared,
      decision: json['decision'] == null
          ? null
          : ApprovalDecision.fromWireName(json['decision'] as String),
      reason: json['reason'] as String?,
    );
  }

  final String itemId;
  final String threadId;
  final String turnId;
  final ApprovalResolvedStatus status;
  final ApprovalDecision? decision;
  final String? reason;
}

/// A client command sent over the WebSocket:
/// `{type: "command", requestId, command, payload}`.
/// Every side-effecting command carries a unique `requestId`; the server
/// replays the stored result for a repeated `requestId` instead of
/// re-executing (docs/protocol.md).
class ClientCommand {
  const ClientCommand({
    required this.requestId,
    required this.command,
    required this.payload,
  });

  final String requestId;
  final CommandName command;
  final Map<String, dynamic> payload;

  Map<String, dynamic> toJson() => {
        'type': 'command',
        'requestId': requestId,
        'command': command.wireName,
        'payload': payload,
      };
}

/// Wire shape of a server reply to a client command (`command-result`).
class CommandResult {
  const CommandResult({
    required this.requestId,
    required this.ok,
    this.data,
    this.errorCode,
    this.errorMessage,
    this.deduped = false,
  });

  factory CommandResult.fromJson(Map<String, dynamic> json) {
    final error = json['error'] as Map?;
    return CommandResult(
      requestId: json['requestId'] as String? ?? '',
      ok: json['ok'] as bool? ?? false,
      data: (json['data'] as Map?)?.cast<String, dynamic>(),
      errorCode: error?['code'] as String?,
      errorMessage: error?['message'] as String?,
      deduped: json['deduped'] as bool? ?? false,
    );
  }

  final String requestId;
  final bool ok;
  final Map<String, dynamic>? data;
  final String? errorCode;
  final String? errorMessage;

  /// True when the server replayed a stored result for a repeated
  /// `requestId` instead of executing again.
  final bool deduped;
}

/// Workspace root from `GET /api/v1/projects` (`{id, name, path}`).
class Project {
  const Project({required this.id, required this.name, required this.path});

  factory Project.fromJson(Map<String, dynamic> json) => Project(
        id: json['id'] as String? ?? '',
        name: json['name'] as String? ?? '',
        path: json['path'] as String? ?? '',
      );

  final String id;
  final String name;
  final String path;
}

/// Session row from `GET /api/v1/sessions` and `session.create` replies.
class SessionInfo {
  const SessionInfo({
    required this.sessionId,
    required this.threadId,
    required this.projectId,
    required this.cwd,
    required this.title,
    required this.status,
  });

  factory SessionInfo.fromJson(Map<String, dynamic> json) => SessionInfo(
        sessionId: json['sessionId'] as String? ?? '',
        threadId: json['threadId'] as String? ?? '',
        projectId: json['projectId'] as String? ?? '',
        cwd: json['cwd'] as String? ?? '',
        title: json['title'] as String? ?? '',
        status: json['status'] as String? ?? '',
      );

  final String sessionId;
  final String threadId;
  final String projectId;
  final String cwd;
  final String title;

  /// Server-side status string, e.g. `active`, `completed`,
  /// `interrupted`.
  final String status;
}
