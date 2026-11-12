import 'package:shared_preferences/shared_preferences.dart';

/// Non-sensitive connection settings (SharedPreferences).
///
/// Only the server address, auto-reconnect preference and the event
/// watermark live here. The pairing token is sensitive and lives in
/// [TokenStore] (Android Keystore), never here.
class SettingsStore {
  SettingsStore(this._prefs);

  static const _serverAddressKey = 'server_address';
  static const _autoReconnectKey = 'auto_reconnect';
  static const _lastSeqKey = 'last_seq';

  final SharedPreferences _prefs;

  static Future<SettingsStore> load() async {
    return SettingsStore(await SharedPreferences.getInstance());
  }

  /// Companion server address as typed by the user, e.g. `192.168.1.10:5291`.
  /// No scheme: the client builds `http://` / `ws://` from it. Phase 1 has
  /// no TLS (docs/protocol.md); do not type `https://` here.
  String? get serverAddress => _prefs.getString(_serverAddressKey);

  Future<void> setServerAddress(String address) =>
      _prefs.setString(_serverAddressKey, address.trim());

  /// Auto-reconnect the WebSocket after a drop (default on).
  bool get autoReconnect => _prefs.getBool(_autoReconnectKey) ?? true;

  Future<void> setAutoReconnect(bool value) =>
      _prefs.setBool(_autoReconnectKey, value);

  /// Highest event `seq` applied so far; sent back as `lastSeq` on
  /// subscribe so the server replays only what was missed.
  int get lastSeq => _prefs.getInt(_lastSeqKey) ?? 0;

  Future<void> setLastSeq(int seq) => _prefs.setInt(_lastSeqKey, seq);

  /// Normalise a user-typed address: strip a scheme and any trailing
  /// slash / path, so `http://192.168.1.10:5291/` becomes
  /// `192.168.1.10:5291`.
  static String normaliseAddress(String raw) {
    var address = raw.trim();
    address = address.replaceFirst(RegExp(r'^https?://'), '');
    address = address.replaceFirst(RegExp(r'^wss?://'), '');
    final slash = address.indexOf('/');
    if (slash >= 0) address = address.substring(0, slash);
    return address;
  }

  /// A bare `host:port` (or host with the default port 5291 implied).
  static bool looksLikeAddress(String raw) {
    final address = normaliseAddress(raw);
    if (address.isEmpty) return false;
    if (address.contains(RegExp(r'\s'))) return false;
    final parts = address.split(':');
    if (parts.length > 2) return false;
    if (parts.length == 2 && int.tryParse(parts[1]) == null) return false;
    return parts[0].isNotEmpty;
  }
}
