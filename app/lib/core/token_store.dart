import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Secure storage for the pairing credential.
///
/// The token is equivalent to Codex control permission on the paired
/// computer (README, "安全要求"), so it lives in Android Keystore-backed
/// storage via `flutter_secure_storage` — never in SharedPreferences,
/// never in logs, never on the clipboard. Only the token and the device
/// id are stored here; the server address is non-sensitive and lives in
/// [SettingsStore].
class TokenStore {
  TokenStore({FlutterSecureStorage storage = const FlutterSecureStorage()})
      : _storage = storage;

  static const _tokenKey = 'codex_token';
  static const _deviceIdKey = 'codex_device_id';

  final FlutterSecureStorage _storage;

  Future<String?> readToken() => _storage.read(key: _tokenKey);

  Future<String?> readDeviceId() => _storage.read(key: _deviceIdKey);

  Future<bool> get isPaired async => await readToken() != null;

  /// Save the token returned once by `POST /api/v1/pairing/claim`.
  Future<void> save({required String deviceId, required String token}) async {
    await _storage.write(key: _deviceIdKey, value: deviceId);
    await _storage.write(key: _tokenKey, value: token);
  }

  /// Forget the pairing locally. Callers must also call
  /// `POST /api/v1/pairing/revoke` first when the server is reachable, so
  /// the server drops the token hash too.
  Future<void> clear() async {
    await _storage.delete(key: _tokenKey);
    await _storage.delete(key: _deviceIdKey);
  }
}
