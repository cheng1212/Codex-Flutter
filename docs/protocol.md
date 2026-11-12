# Companion protocol v1.0.0 (Phase 2)

> 契约在 `packages/protocol/`：`schema/protocol.schema.json`、
> `src/types.ts`、同一组 `fixtures/` 样例驱动 server 与 Flutter 的
> 序列化测试。事件名只用 Phase 0 能力矩阵 §4 里真实的 app-server
> 形状映射出的名字，**不得自创**。
>
> Phase 2 变化：`approval.requested` 增加 `permissions` 一种
> （`item/permissions/requestApproval`）；`plan.updated` 也可来自
> `turn/plan/updated`；`session.error` 可来自 `error` 通知或
> app-server 进程崩溃。协议版本号仍为 `1.0.0`。

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
| `plan.updated` | `item.completed`（todo_list）/ `turn/plan/updated` | 待办/计划摘要 |
| `tool.started` | `item.started`（command_execution / file_change） | |
| `tool.output` | `item` 输出摘要 | 仅摘要，不含原始输出/密钥 |
| `tool.completed` | `item.completed`（command_execution / file_change） | 含 `status`；摘要只有退出码/时长/文件数 |
| `approval.requested` | `item/commandExecution\|fileChange\|permissions/requestApproval` | 见下 |
| `approval.resolved` | 客户端响应 / 清除 | `accepted` / `declined` / `cancelled` / `expired` / `cleared` |
| `session.error` | `error` 通知 / app-server 进程崩溃 | 一行错误摘要，不含原始输出 |
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
- 例外（Phase 2 实测发现）：0.164.0-alpha.9 生成的 schema 里审批
  params **没有** `availableDecisions` 字段（矩阵 §9 的说法来自文档
  页，与版本精确的 schema 不符）。字段按可选处理：服务端发了就用
  发的值；没发时 adapter 用安全默认值——命令/文件审批
  `["accept","decline"]`，权限审批 `["accept","decline","cancel"]`。
  目标机 CLI 版本的字段情况仍需在 Windows 真机上核对（矩阵 §5）。
- 权限审批（`kind:"permissions"`）没有线上的决策枚举：accept =
  按请求授予所要的权限、**仅当前 turn 有效**（`scope:"turn"`），
  decline/cancel = 空授予；`acceptForSession` 只有在显式开启持久
  授权后才可能出现，且同样受 `availableDecisions` 校验。
  请求里带的权限摘要是 `permissions: string[]`（路径/网络开关的一行
  摘要），供审批卡展示。
- 持久化授权默认不开放：`acceptForSession`、`acceptWithExecpolicyAmendment`、
  `applyNetworkPolicyAmendment` 即使出现在 `availableDecisions` 里，
  服务端也返回 `decision-not-allowed`（除非运维在复核后显式开启
  `CODEX_FLUTTER_ALLOW_PERSISTENT_APPROVALS=1`）。
- 请求一旦被答复、过期（默认 15 分钟）、取消、所属 turn 结束或
  客户端断连，就进入"已清除"状态；再答复返回
  `approval-no-longer-pending`（410 语义），adapter 不会被调用，
  同时服务端会发出 `approval.resolved {status:"expired"|"cleared"}`。
  另外两种清除路径：app-server 自己发 `serverRequest/resolved`
  （请求在服务端已被清除），以及 app-server 进程崩溃（在途 turn
  判 interrupted、未答复的请求按已清除处理）。adapter 在清除时
  会代答一个 decline（权限审批为空授予），以免 Codex 的 turn 被
  永远挂起；这个代答永远不是授权。
- `networkApprovalContext` 出现时是"管制网络访问"审批，要单独渲染
  host/protocol，不能当普通命令展示（矩阵 #9）。

## 安全边界（README）

- 默认只绑 `127.0.0.1`；暴露到 LAN 需显式配置 host，且每次请求仍要
  配对令牌。
- 配对码（6 位一次性，5 分钟）只能在 loopback 上创建；令牌是 32 字节
  随机值，只存 SHA-256 哈希，原始令牌只在认领时返回一次，绝不写进日志。
- 每次命令都校验令牌、设备、session 归属和项目目录（规范化路径、
  白名单 workspace 根目录，防 `..` 穿越）。
- 没有通用 shell API；唯一能"跑东西"的路径是 CodexAdapter（mock 或
  真实 app-server）。不把 `auth.json` / API key /
  令牌发给客户端或写进日志；不默认
  `--dangerously-bypass-approvals-and-sandbox`。真实 adapter 只用
  stdio 连本地 app-server，不把 app-server 的 ws 暴露到 LAN。

## 真实 adapter（Phase 2）

- 启动时先跑 `codex --version` 做版本校验：二进制缺失或版本低于
  `CODEX_FLUTTER_CODEX_MIN_VERSION`（默认 `0.166.0`）时拒绝启动
  并提示升级，**不静默回落到 mock**。`GET /healthz` 如实报告
  `codex: {mode, version, connected}`。
- `initialize` 不设 `experimentalApi: true`；`thread/start` 显式传
  `approvalPolicy: "on-request"` + `sandbox: "workspace-write"`。
- 超时：单次 JSON-RPC 请求默认 30 秒；turn 无事件超过默认 10 分钟
  时 adapter 主动 `turn/interrupt`。单条 delta 默认截断到 8192 字符；
  工具输出只进摘要（退出码/时长/文件数），原始输出不进事件与日志。
- 进程崩溃：未完成的 turn 判 `interrupted`、未答复的审批按已清除
  处理；adapter 按配置重连（默认 3 次），重连后用
  `thread/loaded/list` 查内存中已加载线程，对有在途 turn 的线程
  调 `thread/resume` 恢复；重连耗尽后 adapter 保持 down 状态，
  后续调用明确报错，直到 companion 重启。

## 已知限制（Phase 2）

- 真实 adapter 只经过**本地 fake app-server stub**验证（协议往返、
  审批配对、中断、空闲超时、崩溃重连、版本门）。以下仍是目标机
  门槛，未验证，不得声称跑过：登录后真实 turn、一次真实审批往返、
  Windows 原生安装与沙箱（`mxc`/`elevated`/`unelevated`）、
  `turn/interrupt` 与 `turn/steer` 竞态、`model/list`（矩阵 §5）。
- 事件广播目前面向已配对设备；按 session 过滤只在订阅时做，
  多设备细粒度隔离是后续工作。
- 协议不加密：首版只做可信局域网配对；TLS / 二维码配对在 Phase 4
  评估（README）。
