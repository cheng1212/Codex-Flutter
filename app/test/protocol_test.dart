import 'dart:convert';
import 'dart:io';

import 'package:codex_flutter/core/protocol_models.dart';
import 'package:flutter_test/flutter_test.dart';

/// Protocol parsing tests. The inline JSON mirrors the fixtures in
/// `packages/protocol/fixtures/` (protocol v1.0.0); one test also reads
/// the real fixture files so a drift between app and protocol package
/// fails here instead of at runtime.
void main() {
  group('EventEnvelope', () {
    test('parses message.delta fixture shape', () {
      final envelope = EventEnvelope.fromJson(
        jsonDecode(
          '{"eventId":"evt_01JMSGDELTA","payload":{"delta":"Hello from the mock adapter.","itemId":"itm_msg_01","turnId":"trn_mock_01"},"protocolVersion":"1.0.0","seq":4,"sessionId":"ses_mock_01","timestamp":"2026-11-12T15:30:01.000Z","type":"message.delta"}',
        ) as Map<String, dynamic>,
      );
      expect(envelope.type, EventType.messageDelta);
      expect(envelope.seq, 4);
      expect(envelope.sessionId, 'ses_mock_01');
      expect(envelope.payload['delta'], 'Hello from the mock adapter.');
    });

    test('parses session.created fixture shape', () {
      final envelope = EventEnvelope.fromJson(
        jsonDecode(
          '{"eventId":"evt_01JSESSIONCREATED","payload":{"cwd":"/home/user/projects/demo","projectId":"demo","threadId":"thr_mock_01","title":"demo"},"protocolVersion":"1.0.0","seq":1,"sessionId":"ses_mock_01","timestamp":"2026-11-12T15:30:00.000Z","type":"session.created"}',
        ) as Map<String, dynamic>,
      );
      expect(envelope.type, EventType.sessionCreated);
      expect(envelope.payload['threadId'], 'thr_mock_01');
    });

    test('rejects unknown event types instead of inventing them', () {
      expect(
        () => EventEnvelope.fromJson({
          'protocolVersion': '1.0.0',
          'eventId': 'evt_x',
          'seq': 1,
          'sessionId': 'ses_1',
          'timestamp': '2026-11-12T15:30:00.000Z',
          'type': 'session.teleported',
          'payload': {},
        }),
        throwsFormatException,
      );
    });

    test('rejects a mismatched protocolVersion', () {
      expect(
        () => EventEnvelope.fromJson({
          'protocolVersion': '2.0.0',
          'eventId': 'evt_x',
          'seq': 1,
          'sessionId': 'ses_1',
          'timestamp': '2026-11-12T15:30:00.000Z',
          'type': 'message.delta',
          'payload': {},
        }),
        throwsFormatException,
      );
    });

    test('all 13 protocol event types parse', () {
      const types = [
        'session.created',
        'session.status',
        'message.started',
        'message.delta',
        'message.completed',
        'plan.updated',
        'tool.started',
        'tool.output',
        'tool.completed',
        'approval.requested',
        'approval.resolved',
        'session.error',
        'connection.heartbeat',
      ];
      expect(EventType.values.map((t) => t.wireName).toSet(), types.toSet());
      for (final type in types) {
        final envelope = EventEnvelope.fromJson({
          'protocolVersion': '1.0.0',
          'eventId': 'evt_x',
          'seq': 1,
          'sessionId': 'ses_1',
          'timestamp': '2026-11-12T15:30:00.000Z',
          'type': type,
          'payload': {},
        });
        expect(envelope.type.wireName, type);
      }
    });

    test('every fixture file in packages/protocol parses', () {
      final dir = Directory('../packages/protocol/fixtures');
      if (!dir.existsSync()) {
        // Fixtures live next to the app only in the monorepo checkout.
        return;
      }
      final files = dir.listSync().whereType<File>().toList();
      expect(files.length, greaterThanOrEqualTo(8));
      for (final file in files) {
        final json =
            jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
        if (json['type'] == 'command') {
          expect(
            CommandName.values.map((c) => c.wireName),
            contains(json['command']),
          );
        } else {
          // Event fixture: must parse as an envelope.
          EventEnvelope.fromJson(json);
        }
      }
    });
  });

  group('ApprovalRequestedPayload', () {
    test('basic fixture: only accept/decline are offered', () {
      final payload = ApprovalRequestedPayload.fromJson(
        jsonDecode(
          '{"availableDecisions":["accept","decline"],"command":"npm test","cwd":"/home/user/projects/demo","itemId":"itm_approval_01","kind":"commandExecution","reason":"Running tests requires approval.","threadId":"thr_mock_01","turnId":"trn_mock_01"}',
        ) as Map<String, dynamic>,
      );
      expect(
        payload.availableDecisions,
        [ApprovalDecision.accept, ApprovalDecision.decline],
      );
      expect(payload.command, 'npm test');
      expect(payload.networkApprovalContext, isNull);
      expect(payload.isExpired, isFalse);
    });

    test('extended fixture: persistent grant is present but flagged', () {
      final payload = ApprovalRequestedPayload.fromJson(
        jsonDecode(
          '{"availableDecisions":["accept","acceptForSession","decline","cancel"],"command":"npm run deploy","cwd":"/home/user/projects/demo","itemId":"itm_approval_02","kind":"commandExecution","reason":"Deploy needs a persistent grant if you choose it.","threadId":"thr_mock_01","turnId":"trn_mock_01"}',
        ) as Map<String, dynamic>,
      );
      expect(
        payload.availableDecisions,
        contains(ApprovalDecision.acceptForSession),
      );
      expect(ApprovalDecision.acceptForSession.isPersistentGrant, isTrue);
      expect(ApprovalDecision.accept.isPersistentGrant, isFalse);
      expect(ApprovalDecision.acceptWithExecpolicyAmendment.isPersistentGrant,
          isTrue);
      expect(ApprovalDecision.applyNetworkPolicyAmendment.isPersistentGrant,
          isTrue);
    });

    test('network approval context is parsed separately from command', () {
      final payload = ApprovalRequestedPayload.fromJson({
        'itemId': 'itm_net_01',
        'threadId': 'thr_1',
        'turnId': 'trn_1',
        'kind': 'commandExecution',
        'availableDecisions': ['accept', 'decline'],
        'command': 'curl https://example.com',
        'networkApprovalContext': {'host': 'example.com', 'protocol': 'https'},
      });
      expect(payload.networkApprovalContext!.host, 'example.com');
      expect(payload.networkApprovalContext!.protocol, 'https');
    });

    test('permissions kind (Phase 2) parses with grant summaries', () {
      final payload = ApprovalRequestedPayload.fromJson({
        'itemId': 'itm_perm_01',
        'threadId': 'thr_1',
        'turnId': 'trn_1',
        'kind': 'permissions',
        'availableDecisions': ['accept', 'decline'],
        'permissions': ['fs write /home/user/projects/demo', 'network enabled'],
      });
      expect(payload.kind, 'permissions');
      expect(payload.permissions, [
        'fs write /home/user/projects/demo',
        'network enabled',
      ]);
    });

    test('past expiresAt counts as expired', () {
      final payload = ApprovalRequestedPayload.fromJson({
        'itemId': 'itm_old',
        'threadId': 'thr_1',
        'turnId': 'trn_1',
        'kind': 'commandExecution',
        'availableDecisions': ['accept', 'decline'],
        'expiresAt': '2020-01-01T00:00:00.000Z',
      });
      expect(payload.isExpired, isTrue);
    });
  });

  group('ClientCommand / CommandResult', () {
    test('approval.respond command fixture serialises with requestId', () {
      const command = ClientCommand(
        requestId: 'req_01JAPPRRESP',
        command: CommandName.approvalRespond,
        payload: {
          'decision': 'decline',
          'itemId': 'itm_approval_01',
          'sessionId': 'ses_mock_01',
        },
      );
      final json = command.toJson();
      expect(json['type'], 'command');
      expect(json['command'], 'approval.respond');
      expect(json['payload']['decision'], 'decline');
    });

    test('command-result parses ok and error shapes', () {
      final ok = CommandResult.fromJson({
        'type': 'command-result',
        'requestId': 'req_1',
        'ok': true,
        'data': {'sessionId': 'ses_1', 'turnId': 'trn_1'},
      });
      expect(ok.ok, isTrue);
      expect(ok.data!['turnId'], 'trn_1');

      final err = CommandResult.fromJson({
        'type': 'command-result',
        'requestId': 'req_2',
        'ok': false,
        'error': {'code': 'decision-not-offered', 'message': 'not offered'},
      });
      expect(err.ok, isFalse);
      expect(err.errorCode, 'decision-not-offered');
    });

    test('all 5 protocol commands exist, no invented ones', () {
      expect(
        CommandName.values.map((c) => c.wireName).toSet(),
        {
          'session.create',
          'session.resume',
          'message.send',
          'session.cancel',
          'approval.respond',
        },
      );
    });
  });
}
