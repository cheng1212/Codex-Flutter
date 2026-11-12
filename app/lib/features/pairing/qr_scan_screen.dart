import 'package:material_ui/material_ui.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/settings_store.dart';

/// QR scanner for the server address.
///
/// Accepts a QR code containing a plain `host:port` address (or a full
/// `http://host:port` URL, which is normalised the same way as typed
/// input). Only the address is taken from the code — never a token: the
/// pairing token is issued by `POST /api/v1/pairing/claim` and stored in
/// the Keystore, it must never travel in a QR code.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key});

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  final _scannerController = MobileScannerController();
  bool _handled = false;

  @override
  void dispose() {
    _scannerController.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw == null) continue;
      final address = SettingsStore.normaliseAddress(raw);
      if (SettingsStore.looksLikeAddress(address)) {
        _handled = true;
        Navigator.of(context).pop(address);
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('扫码填写服务器地址')),
      body: Column(
        children: [
          Expanded(
            child: MobileScanner(
              controller: _scannerController,
              onDetect: _onDetect,
            ),
          ),
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text('将取景框对准电脑上显示的地址二维码。只读取地址，不读取令牌。'),
          ),
        ],
      ),
    );
  }
}
