# Companion protocol v1.0.0 (Phase 1)

> 契约在 `packages/protocol/`：`schema/protocol.schema.json`、
> `src/types.ts`、同一组 `fixtures/` 样例驱动 server 与 Flutter 的
> 序列化测试。事件名只用 Phase 0 能力矩阵 §4 里真实的 app-server
> 形状映射出的名字，**不得自创**。

## Envelope

每个服务端事件：

```json
{
  "protocolVersion": "1.0.0",
  "eventId": "evt_…",
  "seq": 12,
  "sessionId": "ses_…",
  "timestamp": "2026-11-12T15:30:00.000Z",
  "type": "message.delta",
  "payload": { "delta": "…" }
}
```

`seq` 是 companion 自己分配的全局自增序号（SQLite 事件表主键，
app-server 协议本身没有全局序号，见矩阵 #22），重启后不回退。

## 事件（13 种）

| 事件 | 来源（app-server 形状） | 说明 |
|---|---|---|
| `session.created` | `thread.started` | 新会话建成 |
| `session.status` | `turn.completed` / `thread.started` | `running` / `completed` / `interrupted` |
| `message.started` | `item.started`（agent_message） | |
| `message.delta` | `item/agentMessage/delta` | 流式文本 |
| `message.completed` | `item.completed`（agent_message） | |
| `plan.updated` | `item.completed`（todo_list） | 待办/计划摘要 |
| `tool.started` | `item.started`（command_execution / file_change） | |
| `tool.output` | `item` 输出摘要 | 仅摘要，不含原始输出/密钥 |
| `tool.completed` | `item.completed`（command_execution / file_change） | 含 `status` |
| `approval.requested` | `item/commandExecution|fileChange/requestApproval` | 见下 |
| `approval.resolved` | 客户端响应 / 清除 | `accepted` / `declined` / `cancelled` / `expired` / `cleared` |
| `session.error` | `error` | |
| `connection.heartbeat` | companion 自发 | 默认 30 秒一次 |

## 客户端命令（5 种）

走 WebSocket，形如 `{type:"command", requestId, command, payload}`：

- `session.create {projectId, cwd, title?}` → `{sessionId, threadId, …}`
- `session.resume {sessionId}`
- `message.send {sessionId, text}` → `{turnId}`
- `session.cancel {sessionId}` → `{cancelledTurnId}`
- `approval.respond {sessionId, itemId, decision}` → 见下

每个有副作用的命令必须带客户端生成的唯一 `requestId`。服务端把
执行结果存进 SQLite，**重复的 `requestId` 直接回放已存结果，不再
执行**（消息不会发两次、turn 不会起两次、审批不会答两次）。

## 断线重连

连接后先发 `{type:"subscribe", lastSeq, sessionId?}`：

- 服务端补发所有 `seq > lastSeq` 的事件，然后发 `replay-complete`。
- 若 `lastSeq` 已落后于保留窗口（默认 5000 条），服务端发
  `snapshot-required`（带 `floorSeq`），客户端改走
  `GET /api/v1/sessions/:id/history?afterSeq=&limit=` 拉快照。
- 客户端收到事件后按 `seq` 幂等去重（重复投递只处理一次）。

## 审批（Issue #1 强制约束）

- **`availableDecisions` 是唯一权威来源**。客户端只能渲染请求里带的
  值；服务端收到响应时也会逐条校验：不在列表里的决定返回
  `decision-not-offered`。绝不能写死 accept/decline 四个按钮。
- 持久化授权默认不开放：`acceptForSession`、`acceptWithExecpolicyAmendment`、
  `applyNetworkPolicyAmendment` 即使出现在 `availableDecisions` 里，
  服务端也返回 `decision-not-allowed`（除非运维在复核后显式开启
  `CODEX_FLUTTER_ALLOW_PERSISTENT_APPROVALS=1`）。
- 请求一旦被答复、过期（默认 15 分钟）、取消、所属 turn 结束或
  客户端断连，就进入"已清除"状态；再答复返回
  `approval-no-longer-pending`（410 语义），adapter 不会被调用，
  同时服务端会发出 `approval.resolved {status:"expired"|"cleared"}`。
- `networkApprovalContext` 出现时是"管制网络访问"审批，要单独渲染
  host/protocol，不能当普通命令展示（矩阵 #9）。

## 安全边界（README）

- 默认只绑 `127.0.0.1`；暴露到 LAN 需显式配置 host，且每次请求仍要
  配对令牌。
- 配对码（6 位一次性，5 分钟）只能在 loopback 上创建；令牌是 32 字节
  随机值，只存 SHA-256 哈希，原始令牌只在认领时返回一次，绝不写进日志。
- 每次命令都校验令牌、设备、session 归属和项目目录（规范化路径、
  白名单 workspace 根目录，防 `..` 穿越）。
- 没有通用 shell API；唯一能"跑东西"的路径是 CodexAdapter（本阶段是
  mock，Phase 2 是真实 app-server）。不把 `auth.json` / API key /
  令牌发给客户端或写进日志；不默认
  `--dangerously-bypass-approvals-and-sandbox`。

## 已知限制（Phase 1）

- 未接真实 Codex：全部事件流来自 mock adapter；登录后真实 turn、
  Windows 沙箱、`model/list` 等仍是 Phase 2 门槛（矩阵 §5）。
- 事件广播目前面向已配对设备；按 session 过滤只在订阅时做，
  多设备细粒度隔离是后续工作。
- 协议不加密：首版只做可信局域网配对；TLS / 二维码配对在 Phase 4
  评估（README）。
