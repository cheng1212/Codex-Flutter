import 'package:flutter/foundation.dart';

import 'protocol_models.dart';
import 'rest_client.dart';
import 'settings_store.dart';
import 'token_store.dart';
import 'ws_client.dart';

/// App-wide connection state: pairing, server address, REST + WebSocket
/// clients. Owned by `main.dart` and passed down the widget tree.
///
/// The pairing token is read once from [TokenStore] (Android Keystore)
/// and kept in memory while the app runs. It is never logged.
class AppState extends ChangeNotifier {
  AppState({
    required this.settings,
    required this.tokens,
  });

  final SettingsStore settings;
  final TokenStore tokens;

  String? _token;
  String? _deviceId;
  RestClient? _rest;
  WsClient? _ws;

  bool _initialised = false;

  bool get initialised => _initialised;
  bool get isPaired => _token != null && _token!.isNotEmpty;
  String? get serverAddress => settings.serverAddress;
  String? get deviceId => _deviceId;
  RestClient? get rest => _rest;
  WsClient? get ws => _ws;

  String get restBaseUrl {
    final address = SettingsStore.normaliseAddress(serverAddress ?? '');
    return 'http://$address';
  }

  String get wsUrl {
    final address = SettingsStore.normaliseAddress(serverAddress ?? '');
    return 'ws://$address/ws';
  }

  Future<void> initialise() async {
    _token = await tokens.readToken();
    _deviceId = await tokens.readDeviceId();
    if (isPaired) _buildRestClient();
    _initialised = true;
    notifyListeners();
  }

  void _buildRestClient() {
    _rest?.close();
    _rest = RestClient(baseUrl: restBaseUrl, token: _token!);
  }

  WsClient buildWsClient({
    required bool autoReconnect,
    void Function(int floorSeq)? onSnapshotRequired,
    void Function(int count)? onReplayComplete,
    void Function(EventEnvelope event)? onEvent,
  }) {
    _ws = WsClient(
      wsUrl: wsUrl,
      token: _token!,
      autoReconnect: autoReconnect,
      onSnapshotRequired: onSnapshotRequired,
      onReplayComplete: onReplayComplete,
      onEvent: onEvent,
    );
    return _ws!;
  }

  Future<void> disposeWsClient() async {
    await _ws?.dispose();
    _ws = null;
  }

  /// Called after a successful pairing claim: persist the token in the
  /// Keystore and open the REST client.
  Future<void> completePairing({
    required String deviceId,
    required String token,
    required String serverAddress,
  }) async {
    await tokens.save(deviceId: deviceId, token: token);
    await settings.setServerAddress(
      SettingsStore.normaliseAddress(serverAddress),
    );
    _token = token;
    _deviceId = deviceId;
    _buildRestClient();
    notifyListeners();
  }

  Future<void> updateServerAddress(String address) async {
    final normalised = SettingsStore.normaliseAddress(address);
    await settings.setServerAddress(normalised);
    if (isPaired) _buildRestClient();
    notifyListeners();
  }

  /// Revoke this device on the server (when reachable) and forget the
  /// pairing locally. Returns true when the server confirmed the revoke.
  Future<bool> revokePairing() async {
    var revoked = false;
    if (_rest != null && _deviceId != null) {
      try {
        revoked = await _rest!.revokeDevice(_deviceId!);
      } on Exception {
        // Server unreachable: still clear locally so the token cannot be
        // reused from this phone; the server-side hash stays until the
        // operator removes it. Report the partial result to the caller.
        revoked = false;
      }
    }
    await disposeWsClient();
    _rest?.close();
    _rest = null;
    await tokens.clear();
    _token = null;
    _deviceId = null;
    notifyListeners();
    return revoked;
  }
}
