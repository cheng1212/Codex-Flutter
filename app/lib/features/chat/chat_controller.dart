import 'package:flutter/foundation.dart';

import '../../core/event_store.dart';
import '../../core/protocol_models.dart';
import '../../core/rest_client.dart';
import '../../core/ws_client.dart';

/// Session run state shown in the chat AppBar (docs/protocol.md, README).
enum RunStatus {
  idle('空闲'),
  running('生成中'),
  awaitingApproval('等待审批'),
  completed('完成'),
  failed('失败'),
  disconnected('已断连');

  const RunStatus(this.label);
  final String label;
}

/// One row in the chat timeline.
sealed class ChatItem {
  const ChatItem();
}

class UserMessageItem extends ChatItem {
  const UserMessageItem({required this.text, this.turnId});
  final String text;
  final String? turnId;
}

class AssistantMessageItem extends ChatItem {
  AssistantMessageItem({required this.itemId, required this.turnId});
  final String itemId;
  final String turnId;
  final StringBuffer text = StringBuffer();
  bool completed = false;
}

class ToolItem extends ChatItem {
  ToolItem({
    required this.itemId,
    required this.kind,
    required this.turnId,
  });
  final String itemId;
  final String kind;
  final String turnId;
  String summary = '';
  String status = 'running';
}

class PlanItem extends ChatItem {
  const PlanItem({required this.itemId, required this.summary});
  final String itemId;
  final String summary;
}

class ApprovalItem extends ChatItem {
  ApprovalItem({required this.request});
  final ApprovalRequestedPayload request;
  ApprovalResolvedStatus? resolved;
  bool responding = false;
}

class ErrorItem extends ChatItem {
  const ErrorItem(this.message);
  final String message;
}

class NoteItem extends ChatItem {
  const NoteItem(this.text);
  final String text;
}

/// Chat state for one session: applies protocol events idempotently to a
/// timeline, derives the run status, and drives commands over the
/// WebSocket. REST is used only for the history snapshot ([loadHistory],
/// [fetchSnapshot]); live events and commands go over the WebSocket.
class ChatController extends ChangeNotifier {
  ChatController({
    required this.session,
    required this.rest,
    required this.onLastSeqChanged,
  }) : _store = EventStore();

  final SessionInfo session;
  final RestClient rest;

  /// Called with the newest applied `seq` so the caller can persist the
  /// watermark (sent back as `lastSeq` on the next subscribe).
  final void Function(int lastSeq) onLastSeqChanged;

  final EventStore _store;
  WsClient? _ws;

  final List<ChatItem> items = [];
  RunStatus runStatus = RunStatus.idle;
  ConnectionStatus connectionStatus = ConnectionStatus.disconnected;
  bool loadingHistory = true;
  String? loadError;

  EventStore get eventStore => _store;

  void attachWs(WsClient ws) {
    _ws = ws;
    ws.lastSeq = _store.lastSeq;
  }

  void setConnectionStatus(ConnectionStatus status) {
    connectionStatus = status;
    if (status == ConnectionStatus.disconnected ||
        status == ConnectionStatus.reconnecting) {
      if (runStatus != RunStatus.failed) {
        runStatus = RunStatus.disconnected;
      }
    }
    notifyListeners();
  }

  void restoreWatermark(int seq) => _store.restoreWatermark(seq);

  /// Initial snapshot: full REST history for this session, then live
  /// events arrive over the WebSocket. History events flow through the
  /// same dedup path as live events, so a later replay cannot double
  /// them.
  Future<void> loadHistory() async {
    loadingHistory = true;
    loadError = null;
    notifyListeners();
    try {
      final history = await rest.sessionHistory(session.sessionId);
      for (final event in history.events) {
        applyEvent(event, notify: false);
      }
      if (history.snapshotRequired) {
        items.add(const NoteItem('历史仅保留最近一部分，早期事件已不在服务端窗口内。'));
      }
      loadingHistory = false;
    } on RestException catch (e) {
      loadingHistory = false;
      loadError = '加载历史失败：${e.message}';
    } catch (e) {
      loadingHistory = false;
      loadError = '加载历史失败：$e';
    }
    notifyListeners();
  }

  /// The server answered subscribe with `snapshot-required`: the
  /// `lastSeq` watermark is behind the retained window. Rebuild from a
  /// full REST snapshot when [floorSeq] is ahead of what we have.
  Future<void> fetchSnapshot(int floorSeq) async {
    if (floorSeq > _store.lastSeq) {
      items.add(const NoteItem('错过部分事件，正在从服务端拉取快照补齐…'));
      notifyListeners();
      await loadHistory();
    } else {
      try {
        final history = await rest.sessionHistory(
          session.sessionId,
          afterSeq: _store.lastSeq,
        );
        for (final event in history.events) {
          applyEvent(event, notify: false);
        }
      } on Exception {
        // Snapshot fetch failed: live events continue; the gap will be
        // retried on the next reconnect.
      }
      notifyListeners();
    }
  }

  /// Apply one event envelope. Duplicate `seq` deliveries are skipped
  /// ([EventStore]); unknown payload shapes are ignored, never crash.
  void applyEvent(EventEnvelope event, {bool notify = true}) {
    if (!_store.apply(event.seq)) return;
    onLastSeqChanged(_store.lastSeq);
    _ws?.lastSeq = _store.lastSeq;

    switch (event.type) {
      case EventType.sessionCreated:
        runStatus = RunStatus.idle;
        break;
      case EventType.sessionStatus: {
        final status = event.payload['status'] as String? ?? '';
        switch (status) {
          case 'active':
            runStatus = RunStatus.running;
          case 'completed':
            runStatus = RunStatus.completed;
          case 'interrupted':
            runStatus = RunStatus.idle;
            items.add(const NoteItem('本次运行已中断。'));
          default:
            // Unknown status string: keep the previous status.
            break;
        }
        break;
      }
      case EventType.messageStarted: {
        final itemId = event.payload['itemId'] as String? ?? '';
        final turnId = event.payload['turnId'] as String? ?? '';
        if (itemId.isNotEmpty &&
            items.whereType<AssistantMessageItem>().every((m) => m.itemId != itemId)) {
          items.add(AssistantMessageItem(itemId: itemId, turnId: turnId));
        }
        runStatus = RunStatus.running;
        break;
      }
      case EventType.messageDelta: {
        final itemId = event.payload['itemId'] as String? ?? '';
        final delta = event.payload['delta'] as String? ?? '';
        final message = items.whereType<AssistantMessageItem>().fold<AssistantMessageItem?>(
          null,
          (found, m) => found ?? (m.itemId == itemId ? m : null),
        );
        if (message != null) {
          message.text.write(delta);
        } else if (itemId.isNotEmpty) {
          // Delta arrived before its started event (replay order): create
          // the message row so the text is not lost.
          final created = AssistantMessageItem(
            itemId: itemId,
            turnId: event.payload['turnId'] as String? ?? '',
          )..text.write(delta);
          items.add(created);
        }
        runStatus = RunStatus.running;
        break;
      }
      case EventType.messageCompleted: {
        final itemId = event.payload['itemId'] as String? ?? '';
        for (final m in items.whereType<AssistantMessageItem>()) {
          if (m.itemId == itemId) m.completed = true;
        }
        if (runStatus == RunStatus.running) runStatus = RunStatus.idle;
        break;
      }
      case EventType.planUpdated: {
        final itemId = event.payload['itemId'] as String? ?? '';
        final summary = event.payload['summary'] as String? ?? '';
        items.add(PlanItem(itemId: itemId, summary: summary));
        break;
      }
      case EventType.toolStarted: {
        final itemId = event.payload['itemId'] as String? ?? '';
        final kind = event.payload['kind'] as String? ?? 'tool';
        final turnId = event.payload['turnId'] as String? ?? '';
        if (itemId.isNotEmpty) {
          items.add(ToolItem(itemId: itemId, kind: kind, turnId: turnId));
        }
        break;
      }
      case EventType.toolOutput: {
        final itemId = event.payload['itemId'] as String? ?? '';
        final summary = event.payload['summary'] as String? ?? '';
        for (final t in items.whereType<ToolItem>()) {
          if (t.itemId == itemId && summary.isNotEmpty) t.summary = summary;
        }
        break;
      }
      case EventType.toolCompleted: {
        final itemId = event.payload['itemId'] as String? ?? '';
        final status = event.payload['status'] as String? ?? 'completed';
        final summary = event.payload['summary'] as String? ?? '';
        for (final t in items.whereType<ToolItem>()) {
          if (t.itemId == itemId) {
            t.status = status;
            if (summary.isNotEmpty) t.summary = summary;
          }
        }
        break;
      }
      case EventType.approvalRequested: {
        final request = ApprovalRequestedPayload.fromJson(event.payload);
        if (request.itemId.isEmpty) break;
        final exists = items.whereType<ApprovalItem>().any(
              (a) => a.request.itemId == request.itemId,
            );
        if (!exists) {
          items.add(ApprovalItem(request: request));
        }
        runStatus = RunStatus.awaitingApproval;
        break;
      }
      case EventType.approvalResolved: {
        final resolved = ApprovalResolvedPayload.fromJson(event.payload);
        for (final a in items.whereType<ApprovalItem>()) {
          if (a.request.itemId == resolved.itemId) {
            a.resolved = resolved.status;
            a.responding = false;
          }
        }
        if (runStatus == RunStatus.awaitingApproval) {
          runStatus = _hasPendingApproval()
              ? RunStatus.awaitingApproval
              : RunStatus.running;
        }
        break;
      }
      case EventType.sessionError: {
        final message = event.payload['message'] as String? ??
            event.payload['error'] as String? ??
            '会话出错';
        items.add(ErrorItem(message));
        runStatus = RunStatus.failed;
        break;
      }
      case EventType.connectionHeartbeat:
        // Heartbeat only proves the stream is alive; no UI change.
        break;
    }
    if (notify) notifyListeners();
  }

  bool _hasPendingApproval() => items.whereType<ApprovalItem>().any(
        (a) => a.resolved == null && !a.request.isExpired,
      );

  /// Send a text message (`message.send`). The user row is added
  /// immediately; the server answers with a `command-result` carrying the
  /// `turnId`, and the assistant reply arrives as events.
  Future<void> sendMessage(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty || _ws == null) return;
    items.add(UserMessageItem(text: trimmed));
    runStatus = RunStatus.running;
    notifyListeners();
    final result = await _ws!.sendMessage(session.sessionId, trimmed);
    if (!result.ok) {
      items.add(NoteItem('发送失败：${result.errorMessage ?? result.errorCode}'));
      runStatus = RunStatus.idle;
      notifyListeners();
    }
  }

  /// Cancel the running turn (`session.cancel`).
  Future<void> cancelRun() async {
    if (_ws == null) return;
    final result = await _ws!.cancelSession(session.sessionId);
    if (!result.ok) {
      items.add(NoteItem('取消失败：${result.errorMessage ?? result.errorCode}'));
      notifyListeners();
    }
  }

  /// Answer an approval (`approval.respond`). The decision must come from
  /// the request's own `availableDecisions`; the server rejects anything
  /// else. The card stays disabled while the reply is in flight, and the
  /// authoritative outcome arrives as `approval.resolved`.
  Future<void> respondApproval(
    ApprovalItem item,
    ApprovalDecision decision,
  ) async {
    if (_ws == null || item.resolved != null || item.responding) return;
    item.responding = true;
    notifyListeners();
    final result = await _ws!.respondApproval(
      sessionId: session.sessionId,
      itemId: item.request.itemId,
      decision: decision,
    );
    item.responding = false;
    if (!result.ok) {
      items.add(NoteItem(
        '审批提交失败：${result.errorMessage ?? result.errorCode}。'
        '若提示请求已失效，请以卡片上的最新状态为准。',
      ));
    }
    notifyListeners();
  }
}
