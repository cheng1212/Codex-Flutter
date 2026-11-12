import 'package:material_ui/material_ui.dart';

import '../../core/app_state.dart';
import '../../core/protocol_models.dart';
import '../../core/rest_client.dart';
import '../sessions/sessions_screen.dart';

/// Project list (`GET /api/v1/projects`).
///
/// Tapping a project opens its sessions. A new session is created from
/// the sessions screen with `cwd` set to the project root, which the
/// server validates against its workspace allow-list.
class ProjectsScreen extends StatefulWidget {
  const ProjectsScreen({super.key, required this.appState});

  final AppState appState;

  @override
  State<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends State<ProjectsScreen> {
  List<Project> _projects = [];
  bool _loading = true;
  String? _error;

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
      final projects = await widget.appState.rest!.listProjects();
      if (!mounted) return;
      setState(() {
        _projects = projects;
        _loading = false;
      });
    } on RestException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.code == 'unauthorized'
            ? '令牌已失效，请重新配对。'
            : '加载失败：${e.message}';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '加载失败：$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('项目'),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings),
            tooltip: '连接设置',
            onPressed: () => Navigator.of(context).pushNamed('/settings'),
          ),
        ],
      ),
      body: _buildBody(context),
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
    if (_projects.isEmpty) {
      return const Center(
        child: Text('电脑端还没有配置任何项目。\n请在 companion server 上配置 workspace 后下拉刷新。'),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        itemCount: _projects.length,
        itemBuilder: (context, index) {
          final project = _projects[index];
          return ListTile(
            leading: const Icon(Icons.folder),
            title: Text(project.name),
            subtitle: Text(project.path),
            onTap: () {
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => SessionsScreen(
                    appState: widget.appState,
                    project: project,
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}
