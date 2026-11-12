import 'package:material_ui/material_ui.dart';

import '../../core/app_state.dart';
import '../../core/protocol_models.dart';
import '../../core/rest_client.dart';
import '../chat/chat_screen.dart';

/// Session list for one project (`GET /api/v1/sessions`, filtered by
/// `projectId` client-side; the server list is global).
///
/// Also creates a new session: `session.create {projectId, cwd, title?}`
/// over the WebSocket, with `cwd` set to the project root.
class SessionsScreen extends StatefulWidget {
  const SessionsScreen({super.key, required this.appState, required this.project});

  final AppState appState;
  final Project project;

  @override
  State<SessionsScreen> createState() => _SessionsScreenState();
}

class _SessionsScreenState extends State<SessionsScreen> {
  List<SessionInfo> _sessions = [];
  bool _loading = true;
  String? _error;
  bool _creating = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final all = await widget.appState.rest!.listSessions();
      if (!mounted) return;
      setState(() {
        _sessions =
            all.where((s) => s.projectId == widget.project.id).toList();
        _loading = false;
      });
    } on RestException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '加载失败：${e.message}';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '加载失败：$e';
      });
    }
  }

  Future<void> _createSession() async {
    setState(() => _creating = true);
    final ws = widget.appState.buildWsClient(
      autoReconnect: widget.appState.settings.autoReconnect,
    );
    try {
      await ws.connect();
      final result = await ws.createSession(
        projectId: widget.project.id,
        cwd: widget.project.path,
        title: widget.project.name,
      );
      if (!mounted) return;
      if (!result.ok || result.data == null) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('新建会话失败：${result.errorMessage ?? result.errorCode}')),
        );
        return;
      }
      final session = SessionInfo.fromJson(result.data!);
      await _openChat(session);
    } finally {
      await widget.appState.disposeWsClient();
      if (mounted) setState(() => _creating = false);
    }
  }

  Future<void> _openChat(SessionInfo session) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => ChatScreen(appState: widget.appState, session: session),
      ),
    );
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.project.name)),
      body: _buildBody(context),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _creating ? null : _createSession,
        icon: const Icon(Icons.add),
        label: const Text('新建会话'),
      ),
    );
  }

  Widget _buildBody(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_error!),
            const SizedBox(height: 12),
            FilledButton(onPressed: _load, child: const Text('重试')),
          ],
        ),
      );
    }
    if (_sessions.isEmpty) {
      return const Center(
        child: Text('这个项目还没有会话，点右下角新建一个。'),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        itemCount: _sessions.length,
        itemBuilder: (context, index) {
          final session = _sessions[index];
          return ListTile(
            leading: const Icon(Icons.chat_bubble_outline),
            title: Text(session.title),
            subtitle: Text('${session.status} · ${session.cwd}'),
            onTap: () => _openChat(session),
          );
        },
      ),
    );
  }
}
