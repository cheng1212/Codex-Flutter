import 'dart:async';

import 'package:material_ui/material_ui.dart';

import '../../core/app_state.dart';
import '../../core/protocol_models.dart';
import '../../core/ws_client.dart';
import '../approvals/approval_card.dart';
import 'chat_controller.dart';

/// Chat screen for one session: timeline of messages, tool/plan summaries
/// and approval cards, plus the message composer.
///
/// On open it first loads the REST history snapshot, then opens the
/// WebSocket with the persisted `lastSeq` watermark so only newer events
/// arrive live. A `snapshot-required` reply triggers a REST re-fetch.
class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key, required this.appState, required this.session});

  final AppState appState;
  final SessionInfo session;

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  late final ChatController _controller;
  final _inputController = TextEditingController();
  StreamSubscription<dynamic>? _wsStatusSub;

  @override
  void initState() {
    super.initState();
    _controller = ChatController(
      session: widget.session,
      rest: widget.appState.rest!,
      onLastSeqChanged: (seq) {
        unawaited(widget.appState.settings.setLastSeq(seq));
      },
    );
    _controller.restoreWatermark(widget.appState.settings.lastSeq);
    _controller.addListener(_onControllerChanged);
    _openStream();
  }

  void _onControllerChanged() {
    if (mounted) setState(() {});
  }

  Future<void> _openStream() async {
    await _controller.loadHistory();
    if (!mounted) return;
    final ws = widget.appState.buildWsClient(
      autoReconnect: widget.appState.settings.autoReconnect,
      onSnapshotRequired: _controller.fetchSnapshot,
      onEvent: _controller.applyEvent,
    );
    _controller.attachWs(ws);
    _wsStatusSub = ws.statusStream.listen((status) {
      _controller.setConnectionStatus(status);
    });
    await ws.connect(sessionId: widget.session.sessionId);
    if (!mounted) return;
    _controller.setConnectionStatus(ws.status);
    // Best effort: tell the server this session is being watched again.
    final resume = await ws.resumeSession(widget.session.sessionId);
    if (!mounted) return;
    if (!resume.ok && resume.errorCode != 'not-connected') {
      // A failed resume does not block the chat: live events still flow
      // for a session the server knows. Surface it as a note instead.
      _controller.items.add(
        NoteItem('恢复会话提示：${resume.errorMessage ?? resume.errorCode}'),
      );
      setState(() {});
    }
  }

  @override
  void dispose() {
    _wsStatusSub?.cancel();
    _controller.removeListener(_onControllerChanged);
    _controller.dispose();
    _inputController.dispose();
    unawaited(widget.appState.disposeWsClient());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final status = _controller.runStatus;
    final connected =
        _controller.connectionStatus == ConnectionStatus.connected;
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.session.title),
        actions: [
          Semantics(
            label: '运行状态：${status.label}，连接状态：${_controller.connectionStatus.label}',
            child: Chip(label: Text(status.label)),
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: '重新连接',
            onPressed: () async {
              await widget.appState.ws?.reconnectNow();
            },
          ),
        ],
      ),
      body: Column(
        children: [
          if (!connected)
            Container(
              width: double.infinity,
              color: Theme.of(context).colorScheme.errorContainer,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Text(
                '已断连：${_controller.connectionStatus.label}。'
                '历史内容仍可查看，重连后将自动补齐错过的事件。',
                semanticsLabel: '已断连，重连后将自动补齐错过的事件',
              ),
            ),
          Expanded(child: _buildTimeline(context, connected)),
          _buildComposer(context),
        ],
      ),
    );
  }

  Widget _buildTimeline(BuildContext context, bool connected) {
    if (_controller.loadingHistory) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_controller.loadError != null && _controller.items.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_controller.loadError!),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _controller.loadHistory,
              child: const Text('重试'),
            ),
          ],
        ),
      );
    }
    if (_controller.items.isEmpty) {
      return const Center(
        child: Text('还没有消息，输入文字开始与 Codex 对话。'),
      );
    }
    return ListView.builder(
      padding: const EdgeInsets.all(12),
      itemCount: _controller.items.length,
      itemBuilder: (context, index) {
        final item = _controller.items[index];
        return _buildItem(context, item, connected);
      },
    );
  }

  Widget _buildItem(BuildContext context, ChatItem item, bool connected) {
    switch (item) {
      case UserMessageItem():
        return Align(
          alignment: Alignment.centerRight,
          child: Card(
            color: Theme.of(context).colorScheme.primaryContainer,
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(item.text),
            ),
          ),
        );
      case AssistantMessageItem():
        return Align(
          alignment: Alignment.centerLeft,
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Text(
                item.text.isEmpty
                    ? (item.completed ? '（空回复）' : '正在生成…')
                    : item.text.toString(),
              ),
            ),
          ),
        );
      case ToolItem():
        return ListTile(
          leading: const Icon(Icons.build),
          title: Text(_toolTitle(item)),
          subtitle: item.summary.isEmpty ? null : Text(item.summary),
          dense: true,
        );
      case PlanItem():
        return ListTile(
          leading: const Icon(Icons.checklist),
          title: const Text('计划更新'),
          subtitle: Text(item.summary),
          dense: true,
        );
      case ApprovalItem():
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: ApprovalCard(
            request: item.request,
            resolved: item.resolved,
            connected: connected,
            responding: item.responding,
            onRespond: (decision) =>
                _controller.respondApproval(item, decision),
          ),
        );
      case ErrorItem():
        return ListTile(
          leading: const Icon(Icons.error_outline),
          title: const Text('会话出错'),
          subtitle: Text(item.message),
        );
      case NoteItem():
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text(
            item.text,
            style: Theme.of(context).textTheme.bodySmall,
            textAlign: TextAlign.center,
          ),
        );
    }
  }

  String _toolTitle(ToolItem item) {
    final kind = switch (item.kind) {
      'commandExecution' => '命令执行',
      'fileChange' => '文件修改',
      'todo_list' => '待办',
      _ => item.kind,
    };
    final state = switch (item.status) {
      'completed' => '已完成',
      'failed' => '失败',
      'declined' => '已拒绝',
      _ => '进行中',
    };
    return '$kind · $state';
  }

  Widget _buildComposer(BuildContext context) {
    final running = _controller.runStatus == RunStatus.running ||
        _controller.runStatus == RunStatus.awaitingApproval;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Row(
          children: [
            if (running)
              IconButton(
                icon: const Icon(Icons.stop),
                tooltip: '取消本次运行',
                onPressed: _controller.cancelRun,
              ),
            Expanded(
              child: Semantics(
                label: '输入消息',
                textField: true,
                child: TextField(
                  controller: _inputController,
                  decoration: const InputDecoration(
                    hintText: '输入消息…',
                    border: OutlineInputBorder(),
                  ),
                  minLines: 1,
                  maxLines: 4,
                  textInputAction: TextInputAction.send,
                  onSubmitted: _send,
                ),
              ),
            ),
            const SizedBox(width: 8),
            FilledButton(
              onPressed: () => _send(_inputController.text),
              child: const Text('发送'),
            ),
          ],
        ),
      ),
    );
  }

  void _send(String text) {
    if (text.trim().isEmpty) return;
    _inputController.clear();
    unawaited(_controller.sendMessage(text));
  }
}
