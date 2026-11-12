import 'dart:async';
import 'dart:convert';

import 'package:uuid/uuid.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'protocol_models.dart';

/// WebSocket connection states shown in the UI.
enum ConnectionStatus {
  /// No socket yet (before first connect, or after a manual disconnect).
  disconnected('已断连'),
  connecting('连接中…'),
  connected('已连接'),
  reconnecting('重连中…');

  const ConnectionStatus(this.label);
  final String label;
}

/// WebSocket client for the companion server (`GET /ws?token=…`).
///
/// The WebSocket carries real-time events and interactive commands; REST
/// is used for pairing, lists and history snapshots ([RestClient]).
///
/// Flow (docs/protocol.md):
/// 1. Connect, then send `{type: "subscribe", lastSeq, sessionId?}`.
/// 2. The server replays every event with `seq > lastSeq`, then sends
///    `replay-complete`. If `lastSeq` is behind the retained window the
///    server sends `snapshot-required` instead — the caller must then
///    fetch `GET /api/v1/sessions/:id/history` over REST.
/// 3. Commands are `{type: "command", requestId, command, payload}` and
///    answered with `command-result`. Every side-effecting command gets a
///    fresh unique `requestId` (uuid v4); the server dedupes replays.
///
/// Reconnect: on an unexpected drop the client retries with exponential
/// backoff (1s, 2s, 4s … capped at 30s) when [autoReconnect] is on, and
/// re-subscribes with the latest `lastSeq` so missed events are replayed.
class WsClient {
  WsClient({
    required this.wsUrl,
    required this.token,
    this.autoReconnect = true,
    this.onSnapshotRequired,
    this.onReplayComplete,
    this.onEvent,
    WebSocketChannel Function(Uri uri)? channelFactory,
  }) : _channelFactory =
            channelFactory ?? ((uri) => WebSocketChannel.connect(uri));

  /// e.g. `ws://192.168.1.10:5291/ws`.
  final String wsUrl;
  final String token;
  final bool autoReconnect;

  /// Called when the server answers subscribe with `snapshot-required`
  /// (with the server's `floorSeq`); the caller fetches a REST snapshot.
  final void Function(int floorSeq)? onSnapshotRequired;

  /// Called after a subscribe replay finishes (with the replayed count).
  final void Function(int count)? onReplayComplete;

  /// Called for every `{type: "event"}` envelope from the server.
  /// Dedup by `seq` is the caller's job ([EventStore]).
  final void Function(EventEnvelope event)? onEvent;

  final WebSocketChannel Function(Uri uri) _channelFactory;

  final _statusController = StreamController<ConnectionStatus>.broadcast();
  final _pending = <String, Completer<CommandResult>>{};
  final _uuid = const Uuid();

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _subscription;
  Timer? _reconnectTimer;
  bool _manualClose = false;
  bool _connected = false;
  int _reconnectAttempt = 0;

  /// Highest `seq` the caller has applied; sent as `lastSeq` on every
  /// (re)subscribe. The caller updates this as events arrive.
  int lastSeq = 0;

  /// Session currently being watched, if any. Re-sent on reconnect.
  String? sessionId;

  Stream<ConnectionStatus> get statusStream => _statusController.stream;

  ConnectionStatus get status {
    if (_connected) return ConnectionStatus.connected;
    if (_manualClose) return ConnectionStatus.disconnected;
    if (_reconnectAttempt > 0) return ConnectionStatus.reconnecting;
    return ConnectionStatus.disconnected;
  }

  bool get isConnected => _connected;

  void _emit(ConnectionStatus status) {
    if (!_statusController.isClosed) _statusController.add(status);
  }

  /// Open the socket and subscribe. Safe to call again after a drop; a
  /// live connection is left alone.
  Future<void> connect({String? sessionId}) async {
    if (_connected) {
      if (sessionId != null) {
        this.sessionId = sessionId;
        _sendSubscribe();
      }
      return;
    }
    if (sessionId != null) this.sessionId = sessionId;
    _manualClose = false;
    _emit(_reconnectAttempt > 0
        ? ConnectionStatus.reconnecting
        : ConnectionStatus.connecting);
    final uri = Uri.parse('$wsUrl?token=${Uri.encodeComponent(token)}');
    try {
      _channel = _channelFactory(uri);
      _subscription = _channel!.stream.listen(
        _onMessage,
        onError: (_) => _handleDrop(),
        onDone: _handleDrop,
        cancelOnError: true,
      );
      _connected = true;
      _reconnectAttempt = 0;
      _emit(ConnectionStatus.connected);
      _sendSubscribe();
    } catch (_) {
      _handleDrop();
    }
  }

  void _sendSubscribe() {
    _channel?.sink.add(jsonEncode({
      'type': 'subscribe',
      'lastSeq': lastSeq,
      if (sessionId != null) 'sessionId': sessionId,
    }));
  }

  void _onMessage(dynamic raw) {
    Map<String, dynamic> message;
    try {
      message = jsonDecode(raw as String) as Map<String, dynamic>;
    } catch (_) {
      return; // Ignore unparseable frames; the server only sends JSON.
    }
    switch (message['type'] as String?) {
      case 'event': {
        final eventJson = message['event'] as Map?;
        if (eventJson == null) return;
        try {
          final event =
              EventEnvelope.fromJson(eventJson.cast<String, dynamic>());
          onEvent?.call(event);
        } on FormatException {
          // Unknown event type or protocol version: ignore the frame
          // rather than crashing the stream.
        }
        return;
      }
      case 'command-result': {
        final result = CommandResult.fromJson(message);
        final completer = _pending.remove(result.requestId);
        completer?.complete(result);
        return;
      }
      case 'snapshot-required': {
        final floorSeq = (message['floorSeq'] as num?)?.toInt() ?? 0;
        onSnapshotRequired?.call(floorSeq);
        return;
      }
      case 'replay-complete': {
        final count = (message['count'] as num?)?.toInt() ?? 0;
        onReplayComplete?.call(count);
        return;
      }
    }
  }

  /// Send a side-effecting command and wait for its `command-result`.
  /// Each call generates a fresh unique `requestId`; if the caller retries
  /// the same logical action it must call this again (new id), and the
  /// server dedupes by the id it already executed.
  Future<CommandResult> sendCommand(
    CommandName command,
    Map<String, dynamic> payload, {
    Duration timeout = const Duration(seconds: 30),
  }) {
    if (!_connected) {
      return Future.value(const CommandResult(
        requestId: '',
        ok: false,
        errorCode: 'not-connected',
        errorMessage: '未连接到 companion server',
      ));
    }
    final requestId = _uuid.v4();
    final completer = Completer<CommandResult>();
    _pending[requestId] = completer;
    _channel?.sink.add(jsonEncode(ClientCommand(
      requestId: requestId,
      command: command,
      payload: payload,
    ).toJson()));
    return completer.future.timeout(
      timeout,
      onTimeout: () {
        _pending.remove(requestId);
        return CommandResult(
          requestId: requestId,
          ok: false,
          errorCode: 'timeout',
          errorMessage: '命令超时，服务端可能仍在执行；请勿重复发送',
        );
      },
    );
  }

  /// Convenience wrappers over the 5 protocol commands.
  Future<CommandResult> createSession({
    required String projectId,
    required String cwd,
    String? title,
  }) =>
      sendCommand(CommandName.sessionCreate, {
        'projectId': projectId,
        'cwd': cwd,
        if (title != null) 'title': title,
      });

  Future<CommandResult> resumeSession(String sessionId) =>
      sendCommand(CommandName.sessionResume, {'sessionId': sessionId});

  Future<CommandResult> sendMessage(String sessionId, String text) =>
      sendCommand(CommandName.messageSend, {
        'sessionId': sessionId,
        'text': text,
      });

  Future<CommandResult> cancelSession(String sessionId) =>
      sendCommand(CommandName.sessionCancel, {'sessionId': sessionId});

  /// `approval.respond {sessionId, itemId, decision}`. The caller must
  /// pass a decision that came from the request's own `availableDecisions`
  /// — the server rejects anything not offered (`decision-not-offered`).
  Future<CommandResult> respondApproval({
    required String sessionId,
    required String itemId,
    required ApprovalDecision decision,
  }) =>
      sendCommand(CommandName.approvalRespond, {
        'sessionId': sessionId,
        'itemId': itemId,
        'decision': decision.wireName,
      });

  void _handleDrop() {
    if (_manualClose || _connected == false && _reconnectTimer != null) {
      return;
    }
    _connected = false;
    _failPending('connection-lost', '连接已断开，命令未收到服务端回复');
    if (!autoReconnect || _manualClose) {
      _emit(ConnectionStatus.disconnected);
      return;
    }
    _emit(ConnectionStatus.reconnecting);
    _reconnectAttempt++;
    final delaySeconds = _reconnectAttempt == 1
        ? 1
        : (_reconnectAttempt == 2
            ? 2
            : (_reconnectAttempt == 3 ? 4 : (_reconnectAttempt == 4 ? 8 : 30)));
    // Cap the backoff at 30s from the 5th attempt on.
    final delay = Duration(seconds: delaySeconds > 30 ? 30 : delaySeconds);
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, () {
      if (!_manualClose) connect();
    });
  }

  void _failPending(String code, String message) {
    for (final completer in _pending.values) {
      if (!completer.isCompleted) {
        completer.complete(CommandResult(
          requestId: '',
          ok: false,
          errorCode: code,
          errorMessage: message,
        ));
      }
    }
    _pending.clear();
  }

  /// Reconnect now (used by the "重新连接" button): drops the current
  /// socket if any and starts a fresh connect with the latest `lastSeq`.
  Future<void> reconnectNow() async {
    await _closeSocket();
    _reconnectAttempt = 0;
    await connect();
  }

  /// Manual disconnect: stops auto-reconnect.
  Future<void> disconnect() async {
    _manualClose = true;
    _reconnectTimer?.cancel();
    await _closeSocket();
    _emit(ConnectionStatus.disconnected);
  }

  Future<void> _closeSocket() async {
    await _subscription?.cancel();
    _subscription = null;
    try {
      await _channel?.sink.close();
    } catch (_) {
      // Socket may already be closed.
    }
    _channel = null;
    _connected = false;
  }

  Future<void> dispose() async {
    _manualClose = true;
    _reconnectTimer?.cancel();
    await _closeSocket();
    await _statusController.close();
  }
}
