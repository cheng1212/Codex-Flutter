import 'package:material_ui/material_ui.dart';

import '../../core/app_state.dart';
import '../../core/rest_client.dart';
import '../../core/settings_store.dart';
import 'qr_scan_screen.dart';

/// Pairing screen: enter (or scan) the companion server address and the
/// one-time pairing code, then claim it.
///
/// The 6-digit code is minted on the desktop itself
/// (`POST /api/v1/pairing/code`, loopback only, 5 min expiry) and shown on
/// the computer screen; the phone only claims it
/// (`POST /api/v1/pairing/claim`). The returned token is saved straight
/// into [TokenStore] (Android Keystore) and is never displayed, logged
/// or copied to the clipboard.
class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key, required this.appState, required this.onPaired});

  final AppState appState;
  final VoidCallback onPaired;

  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  final _formKey = GlobalKey<FormState>();
  final _addressController = TextEditingController();
  final _codeController = TextEditingController();
  final _deviceNameController = TextEditingController(text: 'Android 手机');

  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _addressController.text = widget.appState.serverAddress ?? '';
  }

  @override
  void dispose() {
    _addressController.dispose();
    _codeController.dispose();
    _deviceNameController.dispose();
    super.dispose();
  }

  Future<void> _claim() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final address = SettingsStore.normaliseAddress(_addressController.text);
    try {
      final result = await RestClient.claimPairing(
        baseUrl: 'http://$address',
        code: _codeController.text,
        deviceName: _deviceNameController.text,
      );
      await widget.appState.completePairing(
        deviceId: result.deviceId,
        token: result.token,
        serverAddress: address,
      );
      if (!mounted) return;
      widget.onPaired();
    } on RestException catch (e) {
      setState(() {
        _error = e.code == 'invalid-code'
            ? '配对码错误、已过期或已被使用，请在电脑上重新生成。'
            : '配对失败：${e.message}';
      });
    } catch (e) {
      setState(() {
        _error = '无法连接到服务器，请检查地址与局域网：$e';
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _scanAddress() async {
    final scanned = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const QrScanScreen()),
    );
    if (scanned != null && mounted) {
      setState(() => _addressController.text = scanned);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('配对 companion server')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: _formKey,
          child: ListView(
            children: [
              const Text(
                '先在电脑上启动 companion server，它会显示局域网地址和一个 6 位一次性配对码（5 分钟有效）。在下面输入地址和配对码即可配对。',
              ),
              const SizedBox(height: 16),
              TextFormField(
                controller: _addressController,
                decoration: InputDecoration(
                  labelText: '服务器地址',
                  hintText: '例如 192.168.1.10:5291',
                  suffixIcon: IconButton(
                    icon: const Icon(Icons.qr_code_scanner),
                    tooltip: '扫码填写地址',
                    onPressed: _scanAddress,
                  ),
                ),
                keyboardType: TextInputType.url,
                textInputAction: TextInputAction.next,
                validator: (value) {
                  if (value == null ||
                      !SettingsStore.looksLikeAddress(value)) {
                    return '请输入 host:port 形式的地址';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _codeController,
                decoration: const InputDecoration(
                  labelText: '配对码',
                  hintText: '6 位数字',
                ),
                keyboardType: TextInputType.number,
                textInputAction: TextInputAction.next,
                validator: (value) {
                  if (value == null || value.trim().length != 6) {
                    return '配对码是 6 位数字';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _deviceNameController,
                decoration: const InputDecoration(
                  labelText: '设备名称',
                  hintText: '用于在电脑端识别这台手机',
                ),
                textInputAction: TextInputAction.done,
                validator: (value) {
                  if (value == null || value.trim().isEmpty) {
                    return '请填写设备名称';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 20),
              if (_error != null) ...[
                Text(
                  _error!,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
                const SizedBox(height: 12),
              ],
              FilledButton(
                onPressed: _busy ? null : _claim,
                child: _busy
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('配对'),
              ),
              const SizedBox(height: 12),
              const Text(
                '配对成功后，访问令牌只保存在本机 Android Keystore 中，不会显示在界面、日志或剪贴板里。',
                style: TextStyle(fontSize: 12),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
