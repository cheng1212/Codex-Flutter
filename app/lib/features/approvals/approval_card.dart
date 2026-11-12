import 'package:material_ui/material_ui.dart';

import '../../core/protocol_models.dart';
import 'approval_logic.dart';

/// Approval card for one `approval.requested` event.
///
/// Rendering is driven strictly by the request's own `availableDecisions`
/// (see `approval_logic.dart`): only those decisions get buttons, and
/// persistent grants are shown disabled with a note. Once the request is
/// resolved / expired / cancelled / disconnected, the card shows "已失效"
/// and no button is clickable.
///
/// [onRespond] is called with the chosen decision; the parent sends
/// `approval.respond` over the WebSocket and disables the card while the
/// reply is in flight ([responding]).
class ApprovalCard extends StatelessWidget {
  const ApprovalCard({
    super.key,
    required this.request,
    required this.resolved,
    required this.connected,
    required this.responding,
    required this.onRespond,
  });

  final ApprovalRequestedPayload request;
  final ApprovalResolvedStatus? resolved;
  final bool connected;
  final bool responding;
  final void Function(ApprovalDecision decision) onRespond;

  @override
  Widget build(BuildContext context) {
    final answerable = isAnswerable(
      request: request,
      resolved: resolved,
      connected: connected,
    );
    final live = liveDecisions(request);
    final persistent = disabledPersistentDecisions(request);
    final theme = Theme.of(context);

    final title = request.networkApprovalContext != null
        ? '网络访问审批'
        : switch (request.kind) {
            'fileChange' => '文件修改审批',
            'permissions' => '权限授予审批',
            _ => '命令执行审批',
          };

    return Semantics(
      label: '$title，${answerable ? '待处理' : invalidReason(request: request, resolved: resolved, connected: connected)}',
      container: true,
      child: Card(
        color: answerable
            ? theme.colorScheme.errorContainer
            : theme.colorScheme.surfaceContainerHighest,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    answerable ? Icons.warning_amber : Icons.info_outline,
                    color: theme.colorScheme.onErrorContainer,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      title,
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  Text(
                    answerable ? '待处理' : invalidReason(
                        request: request,
                        resolved: resolved,
                        connected: connected,
                      ),
                    style: theme.textTheme.bodyMedium,
                  ),
                ],
              ),
              if (request.reason != null) ...[
                const SizedBox(height: 8),
                Text(request.reason!),
              ],
              if (request.networkApprovalContext != null) ...[
                const SizedBox(height: 8),
                Text(
                  '请求访问网络：'
                  'host ${request.networkApprovalContext!.host ?? '未知'}，'
                  'protocol ${request.networkApprovalContext!.protocol ?? '未知'}',
                ),
              ] else if (request.permissions != null) ...[
                const SizedBox(height: 8),
                const Text('请求授予以下权限：'),
                for (final grant in request.permissions!)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text('· $grant'),
                  ),
              ] else if (request.command != null) ...[
                const SizedBox(height: 8),
                Text(
                  '命令：${request.command!}',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontFamily: 'monospace',
                  ),
                ),
              ],
              if (request.cwd != null) ...[
                const SizedBox(height: 4),
                Text('目录：${request.cwd!}'),
              ],
              if (request.expiresAt != null) ...[
                const SizedBox(height: 4),
                Text('有效期至：${request.expiresAt!.toLocal()}'),
              ],
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final decision in live)
                    FilledButton(
                      onPressed: answerable && !responding
                          ? () => onRespond(decision)
                          : null,
                      child: Text(decision.label),
                    ),
                  for (final decision in persistent)
                    OutlinedButton(
                      onPressed: null,
                      child: Text(decision.label),
                    ),
                ],
              ),
              if (persistent.isNotEmpty) ...[
                const SizedBox(height: 8),
                const Text(
                  '灰色选项为持久授权，服务端默认不开放，需电脑端运维确认后显式开启。',
                  style: TextStyle(fontSize: 12),
                ),
              ],
              if (responding) ...[
                const SizedBox(height: 8),
                const Text('正在提交决定…'),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
