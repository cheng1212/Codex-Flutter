import 'package:material_ui/material_ui.dart';

import '../../core/app_state.dart';
import '../../core/protocol_models.dart';
import '../../core/rest_client.dart';
import '../../core/settings_store.dart';

/// Connection settings: server address, auto-reconnect, server version,
/// and revoking this device.
///
/// Revoking calls `POST /api/v1/pairing/revoke` and then forgets the
/// token locally; if the server is unreachable the local token is still
/// cleared and the screen says the server-side revoke is pending.
class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.appState, required this.onUnpaired});

  final AppState appState;
  final VoidCallback onUnpaired;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _addressController = TextEditingController();
  Map<String, dynamic>? _health;
  String? _healthError;
  bool _revoking = false;

  @override
  void initState() {
    super.initState();
    _addressController.text = widget.appState.serverAddress ?? '';
    _loadHealth();
  }

  @override
  void dispose() {
    _addressController.dispose();
    super.dispose();
  }

  Future<void> _loadHealth() async {
    try {
      final health = await widget.appState.rest!.health();
      if (!mounted) return;
      setState(() => _health = health);
    } on RestException catch (e) {
      if (!mounted) return;
      setState(() => _healthError = '获取服务端状态失败：${e.message}');
    } catch (e) {
      if (!mounted) return;
      setState(() => _healthError = '获取服务端状态失败：$e');
    }
  }

  Future<void> _saveAddress() async {
    final address = _addressController.text;
    if (!SettingsStore.looksLikeAddress(address)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请输入 host:port 形式的地址')),
      );
      return;
    }
    await widget.appState.updateServerAddress(address);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('服务器地址已保存，下次连接生效')),
    );
    await _loadHealth();
  }

  /// Human-readable summary of the `/healthz` document. The `codex`
  /// object differs between mock mode (`script`) and real mode
  /// (`version`, `connected`), so only present fields are shown.
  String _healthSummary(Map<String, dynamic> health) {
    final codex = health['codex'] as Map?;
    final parts = <String>[
      '状态：${health['status']}',
      '服务端版本：${health['serverVersion']}',
      '协议版本：${health['protocolVersion']}',
      'Codex 模式：${codex?['mode']}',
    ];
    if (codex?['version'] != null) parts.add('Codex 版本：${codex!['version']}');
    if (codex?['connected'] != null) {
      parts.add('Codex 已连接：${codex!['connected'] == true ? '是' : '否'}');
    }
    if (codex?['script'] != null) parts.add('Mock 脚本：${codex!['script']}');
    return parts.join(' · ');
  }

  Future<void> _revoke() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('撤销本设备'),
        content: const Text(
          '撤销后这台手机将无法再连接这台电脑，需要重新配对才能使用。确定吗？',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('撤销'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() => _revoking = true);
    final serverConfirmed = await widget.appState.revokePairing();
    if (!mounted) return;
    setState(() => _revoking = false);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          serverConfirmed
              ? '本设备已撤销'
              : '本地配对已清除，但未能连通服务器确认撤销；请稍后在电脑端检查设备列表',
        ),
      ),
    );
    widget.onUnpaired();
    // Leave the settings page: the app root now shows the pairing
    // screen, since this device is no longer paired.
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final settings = widget.appState.settings;
    return Scaffold(
      appBar: AppBar(title: const Text('连接设置')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _addressController,
            decoration: const InputDecoration(
              labelText: '服务器地址',
              hintText: '例如 192.168.1.10:5291',
              helperText: '仅可信局域网。Phase 1 协议不加密，请勿暴露到公网。',
            ),
            keyboardType: TextInputType.url,
          ),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _saveAddress,
            child: const Text('保存地址'),
          ),
          const Divider(height: 32),
          SwitchListTile(
            title: const Text('断线自动重连'),
            subtitle: const Text('断开后按退避间隔重连，并用 lastSeq 补齐错过的事件'),
            value: settings.autoReconnect,
            onChanged: (value) async {
              await settings.setAutoReconnect(value);
              setState(() {});
            },
          ),
          const Divider(height: 32),
          ListTile(
            title: const Text('服务端状态'),
            subtitle: Text(
              _health != null ? _healthSummary(_health!) : (_healthError ?? '加载中…'),
            ),
          ),
          const ListTile(
            title: Text('协议版本'),
            subtitle: Text(kProtocolVersion),
          ),
          const Divider(height: 32),
          FilledButton(
            onPressed: _revoking ? null : _revoke,
            child: _revoking
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('撤销本设备配对'),
          ),
        ],
      ),
    );
  }
}
