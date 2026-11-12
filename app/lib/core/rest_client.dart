import 'dart:convert';

import 'package:http/http.dart' as http;

import 'protocol_models.dart';

/// REST client for the companion server (Phase 1 routes, `server/README.md`).
///
/// REST is used for pairing, project/session lists and history snapshots.
/// Real-time events and commands go over the WebSocket ([WsClient]).
/// The pairing token is sent as a `Bearer` header and is never logged.
class RestClient {
  RestClient({required this.baseUrl, required this.token, http.Client? httpClient})
      : _http = httpClient ?? http.Client();

  /// Base URL without a trailing slash, e.g. `http://192.168.1.10:5291`.
  final String baseUrl;

  /// Paired device token. Kept in memory only for the session; stored in
  /// [TokenStore] (Android Keystore) at rest.
  final String token;

  final http.Client _http;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      };

  void close() => _http.close();

  Future<Map<String, dynamic>> _get(String path) async {
    final response = await _http.get(
      Uri.parse('$baseUrl$path'),
      headers: _headers,
    );
    return _decode(response);
  }

  Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body,
  ) async {
    final response = await _http.post(
      Uri.parse('$baseUrl$path'),
      headers: _headers,
      body: jsonEncode(body),
    );
    return _decode(response);
  }

  Map<String, dynamic> _decode(http.Response response) {
    final body = response.body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final error = body['error'] as Map?;
      throw RestException(
        error?['code'] as String? ?? 'http-${response.statusCode}',
        error?['message'] as String? ?? 'request failed',
        response.statusCode,
      );
    }
    return body;
  }

  /// `GET /healthz` — no auth on the server, but the client still sends
  /// its token when it has one. Returns the raw health document.
  Future<Map<String, dynamic>> health() => _get('/healthz');

  /// `GET /api/v1/projects` — workspace roots the operator configured.
  Future<List<Project>> listProjects() async {
    final body = await _get('/api/v1/projects');
    final projects = body['projects'] as List? ?? const [];
    return projects
        .map((p) => Project.fromJson((p as Map).cast<String, dynamic>()))
        .toList();
  }

  /// `GET /api/v1/sessions` — all sessions known to the server.
  Future<List<SessionInfo>> listSessions() async {
    final body = await _get('/api/v1/sessions');
    final sessions = body['sessions'] as List? ?? const [];
    return sessions
        .map((s) => SessionInfo.fromJson((s as Map).cast<String, dynamic>()))
        .toList();
  }

  /// `GET /api/v1/sessions/:id/history?afterSeq=&limit=` — snapshot
  /// fallback when the WebSocket replay window is exhausted
  /// (`snapshot-required`) or after a long disconnect.
  Future<SessionHistory> sessionHistory(
    String sessionId, {
    int afterSeq = 0,
    int limit = 500,
  }) async {
    final body = await _get(
      '/api/v1/sessions/${Uri.encodeComponent(sessionId)}/history'
      '?afterSeq=$afterSeq&limit=$limit',
    );
    final events = body['events'] as List? ?? const [];
    return SessionHistory(
      sessionId: body['sessionId'] as String? ?? sessionId,
      snapshotRequired: body['snapshotRequired'] as bool? ?? false,
      events: events
          .map((e) => EventEnvelope.fromJson((e as Map).cast<String, dynamic>()))
          .toList(),
    );
  }

  /// `POST /api/v1/pairing/revoke {deviceId}` — a device revokes itself.
  /// After a successful revoke the caller must also clear [TokenStore].
  Future<bool> revokeDevice(String deviceId) async {
    final body = await _post('/api/v1/pairing/revoke', {'deviceId': deviceId});
    return body['revoked'] as bool? ?? false;
  }

  /// `POST /api/v1/pairing/claim {code, deviceName}` — claims a one-time
  /// 6-digit pairing code minted on the desktop (loopback only) and returns
  /// `{deviceId, token}` once. This call is unauthenticated, so it uses a
  /// bare client call instead of the bearer-token helpers above, and the
  /// token is handed straight to [TokenStore] by the caller.
  static Future<ClaimResult> claimPairing({
    required String baseUrl,
    required String code,
    required String deviceName,
    http.Client? httpClient,
  }) async {
    final client = httpClient ?? http.Client();
    try {
      final response = await client.post(
        Uri.parse('$baseUrl/api/v1/pairing/claim'),
        headers: const {'Content-Type': 'application/json'},
        body: jsonEncode({'code': code.trim(), 'deviceName': deviceName.trim()}),
      );
      final body = response.body.isEmpty
          ? <String, dynamic>{}
          : jsonDecode(response.body) as Map<String, dynamic>;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final error = body['error'] as Map?;
        throw RestException(
          error?['code'] as String? ?? 'http-${response.statusCode}',
          error?['message'] as String? ?? 'pairing failed',
          response.statusCode,
        );
      }
      return ClaimResult(
        deviceId: body['deviceId'] as String? ?? '',
        token: body['token'] as String? ?? '',
      );
    } finally {
      if (httpClient == null) client.close();
    }
  }
}

class ClaimResult {
  const ClaimResult({required this.deviceId, required this.token});
  final String deviceId;

  /// Returned once by the server. The caller must store it in
  /// [TokenStore] immediately and never log or display it.
  final String token;
}

class SessionHistory {
  const SessionHistory({
    required this.sessionId,
    required this.snapshotRequired,
    required this.events,
  });
  final String sessionId;

  /// True when the requested `afterSeq` is below the server's retained
  /// floor: the events list is only a partial window and the client
  /// should rebuild the view from these events, not assume completeness.
  final bool snapshotRequired;
  final List<EventEnvelope> events;
}

class RestException implements Exception {
  const RestException(this.code, this.message, [this.statusCode]);
  final String code;
  final String message;
  final int? statusCode;

  @override
  String toString() => 'RestException($code): $message';
}
