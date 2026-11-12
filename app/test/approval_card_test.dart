import 'package:codex_flutter/core/protocol_models.dart';
import 'package:codex_flutter/features/approvals/approval_card.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';

/// Widget tests for the approval card: buttons are driven strictly by
/// `availableDecisions`, persistent grants render disabled, and expired
/// requests render with no clickable button.
void main() {
  Future<void> pumpCard(
    WidgetTester tester,
    ApprovalRequestedPayload request, {
    ApprovalResolvedStatus? resolved,
    bool connected = true,
    bool responding = false,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ApprovalCard(
            request: request,
            resolved: resolved,
            connected: connected,
            responding: responding,
            onRespond: (_) {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  ApprovalRequestedPayload basicRequest() => const ApprovalRequestedPayload(
        itemId: 'itm_approval_01',
        threadId: 'thr_mock_01',
        turnId: 'trn_mock_01',
        kind: 'commandExecution',
        availableDecisions: [
          ApprovalDecision.accept,
          ApprovalDecision.decline,
        ],
        command: 'npm test',
        reason: 'Running tests requires approval.',
      );

  ApprovalRequestedPayload extendedRequest() => const ApprovalRequestedPayload(
        itemId: 'itm_approval_02',
        threadId: 'thr_mock_01',
        turnId: 'trn_mock_01',
        kind: 'commandExecution',
        availableDecisions: [
          ApprovalDecision.accept,
          ApprovalDecision.acceptForSession,
          ApprovalDecision.decline,
          ApprovalDecision.cancel,
        ],
        command: 'npm run deploy',
        reason: 'Deploy needs a persistent grant if you choose it.',
      );

  testWidgets('basic request renders exactly accept + decline',
      (tester) async {
    await pumpCard(tester, basicRequest());

    expect(find.text('批准（本次）'), findsOneWidget);
    expect(find.text('拒绝'), findsOneWidget);
    expect(find.text('本会话都批准'), findsNothing);
    expect(find.text('取消'), findsNothing);
    expect(find.text('命令执行审批'), findsOneWidget);
    expect(find.textContaining('npm test'), findsOneWidget);

    // Both buttons are enabled.
    final accept = tester.widget<FilledButton>(
      find.ancestor(
        of: find.text('批准（本次）'),
        matching: find.byType(FilledButton),
      ),
    );
    expect(accept.onPressed, isNotNull);
  });

  testWidgets('extended request: persistent grant is disabled with a note',
      (tester) async {
    final decisions = <ApprovalDecision>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ApprovalCard(
            request: extendedRequest(),
            resolved: null,
            connected: true,
            responding: false,
            onRespond: decisions.add,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('批准（本次）'), findsOneWidget);
    expect(find.text('拒绝'), findsOneWidget);
    expect(find.text('取消'), findsOneWidget);
    // The persistent grant is rendered but disabled (OutlinedButton with
    // a null onPressed), plus the explanatory note.
    expect(find.text('本会话都批准'), findsOneWidget);
    final persistent = tester.widget<OutlinedButton>(
      find.ancestor(
        of: find.text('本会话都批准'),
        matching: find.byType(OutlinedButton),
      ),
    );
    expect(persistent.onPressed, isNull);
    expect(find.textContaining('持久授权'), findsOneWidget);

    // Tapping a live button calls onRespond with that decision.
    await tester.tap(find.text('拒绝'));
    expect(decisions, [ApprovalDecision.decline]);
  });

  testWidgets('expired request shows 已过期 and no clickable button',
      (tester) async {
    final expired = ApprovalRequestedPayload(
      itemId: 'itm_old',
      threadId: 'thr_1',
      turnId: 'trn_1',
      kind: 'commandExecution',
      availableDecisions: const [
        ApprovalDecision.accept,
        ApprovalDecision.decline,
      ],
      expiresAt: DateTime.utc(2020, 1, 1),
    );
    var responded = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ApprovalCard(
            request: expired,
            resolved: null,
            connected: true,
            responding: false,
            onRespond: (_) => responded = true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('已过期'), findsWidgets);
    for (final button in tester.widgetList<FilledButton>(
      find.byType(FilledButton),
    )) {
      expect(button.onPressed, isNull);
    }
    await tester.tap(find.text('批准（本次）'), warnIfMissed: false);
    expect(responded, isFalse);
  });

  testWidgets('resolved request shows the outcome and disables buttons',
      (tester) async {
    await pumpCard(
      tester,
      basicRequest(),
      resolved: ApprovalResolvedStatus.declined,
    );
    expect(find.text('已拒绝'), findsWidgets);
    for (final button in tester.widgetList<FilledButton>(
      find.byType(FilledButton),
    )) {
      expect(button.onPressed, isNull);
    }
  });

  testWidgets('permissions approval renders grants, not a command',
      (tester) async {
    const request = ApprovalRequestedPayload(
      itemId: 'itm_perm',
      threadId: 'thr_1',
      turnId: 'trn_1',
      kind: 'permissions',
      availableDecisions: [
        ApprovalDecision.accept,
        ApprovalDecision.decline,
      ],
      permissions: ['fs write /home/user/projects/demo'],
    );
    await pumpCard(tester, request);
    expect(find.text('权限授予审批'), findsOneWidget);
    expect(find.textContaining('fs write'), findsOneWidget);
    expect(find.text('批准（本次）'), findsOneWidget);
  });

  testWidgets('network approval renders host/protocol separately',
      (tester) async {
    const request = ApprovalRequestedPayload(
      itemId: 'itm_net',
      threadId: 'thr_1',
      turnId: 'trn_1',
      kind: 'commandExecution',
      availableDecisions: [
        ApprovalDecision.accept,
        ApprovalDecision.decline,
      ],
      command: 'curl https://example.com',
      networkApprovalContext: NetworkApprovalContext(
        host: 'example.com',
        protocol: 'https',
      ),
    );
    await pumpCard(tester, request);
    expect(find.text('网络访问审批'), findsOneWidget);
    expect(find.textContaining('example.com'), findsWidgets);
    expect(find.textContaining('https'), findsWidgets);
  });
}
