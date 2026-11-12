# Codex Flutter — shared protocol (Phase 1)

协议版本 `1.0.0`。本包是 server 与未来 Flutter 客户端的共享契约。

## 内容

- `schema/protocol.schema.json` — 事件 envelope、13 种服务端事件、5 种客户端命令、审批请求/响应的 JSON Schema。
- `src/types.ts` — 与 schema 对齐的 TypeScript 类型（手工维护，测试用 fixtures + schema 校验保证一致）。
- `fixtures/` — 事件与命令样例；同一组样例驱动 server 与 Flutter 的序列化测试。

## 规则（来自 Phase 0 能力矩阵 §4/§6）

- 事件名**不得自创**，只能用矩阵里真实的 app-server 形状映射出的名字：
  `session.created`、`session.status`、`message.started`、`message.delta`、
  `message.completed`、`plan.updated`、`tool.started`、`tool.output`、
  `tool.completed`、`approval.requested`、`approval.resolved`、`session.error`、
  `connection.heartbeat`。
- 客户端命令：`session.create`、`session.resume`、`message.send`、`session.cancel`、
  `approval.respond`，每个有副作用的命令必须带唯一 `requestId`。
- 审批请求的 `availableDecisions` 是权威来源：客户端只能渲染请求里带的值，
  不得写死 accept/decline；`acceptForSession`、execpolicy 修正、网络策略修正
  默认不开放（服务端也会拒绝）。
- 服务端事件自带全局自增 `seq`（companion 自己实现，app-server 协议本身没有
  全局序号，见矩阵 #22）。断线重连用 `lastSeq` 补发；补发窗口不够时服务端回
  `snapshot-required`，客户端走 REST 历史快照。
