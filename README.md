# Codex Flutter

> 用安卓手机安全地查看和操作自己电脑上的 Codex coding agent。
>
> A Flutter Android client and a local companion server for controlling Codex on your own computer.

本仓库是项目说明与开发蓝图，供后续实现 agent 按阶段开发。产品目标是让用户在手机上连接自己的电脑，查看 Codex 会话的实时进展、继续对话、查看任务和工具事件，并在需要时处理权限请求。架构参考 [`CloudCLI`](https://github.com/cheng1212/CloudCLI) 的本地 Web 控制台与服务端模块化设计，以及 [`Claude-Flutter`](https://github.com/cheng1212/Claude-Flutter) 的 Flutter 客户端、电脑端 companion server、WebSocket 事件流设计；本项目专门面向 Codex，不能把 Claude 的 SDK 或会话协议误当成 Codex 接口。

## 产品边界

- 手机端是远程控制与状态查看客户端；Codex agent 运行在用户自己的电脑上。
- 电脑端服务是唯一接触 Codex CLI/SDK、项目目录和本地进程的一层。
- 首版只支持可信局域网内配对连接；公网中继、云端托管和账号体系不属于 MVP。
- 所有可能触发代码修改、命令执行或授权的动作都必须遵守 Codex 提供的权限与沙箱机制；手机端不能静默绕过确认。
- 不上传源代码、会话内容或密钥到项目作者的服务器。手机与电脑直接通信。

## 目标 MVP

1. 电脑端启动 companion server，生成一次性配对码或高熵访问令牌，并显示局域网地址。
2. 安卓端输入/扫描地址并配对，安全保存令牌，支持断线重连。
3. 展示可用项目和 Codex 会话；支持新建会话、继续会话、发送文本消息。
4. 实时呈现 assistant 输出、状态变化、待办/计划、工具调用摘要和错误。
5. 若底层 Codex 接口产生显式审批请求，在手机显示请求详情并让用户明确批准或拒绝；断连、过期和重复操作均需安全处理。
6. 展示连接状态、服务端版本、当前项目和会话运行状态。

首版暂不做文件上传、任意 shell 终端、文件编辑器、cron、费用统计、推送通知、worktree 管理、多用户和公网 relay。完成 MVP 后根据真实 Codex 接口能力再排期。

## 建议架构

```text
┌────────────────────┐     HTTPS/REST + WSS      ┌────────────────────────┐
│ Android app        │ ◄──────────────────────► │ Desktop companion      │
│ Flutter / Dart     │    LAN, paired token      │ Node.js / TypeScript   │
│ UI + local token   │                           │ auth + API + event hub  │
└────────────────────┘                           └────────────┬───────────┘
                                                             │
                                                    Codex adapter boundary
                                                             │
                                               ┌─────────────▼────────────┐
                                               │ Supported Codex CLI/SDK  │
                                               │ on the user's computer  │
                                               └──────────────────────────┘
```

### 电脑端 companion server

- Node.js 20+、TypeScript；按职责拆分 auth/pairing、projects、sessions、Codex adapter、WebSocket event hub、persistence、logging。
- 先调查并验证当前 Codex CLI 与官方 SDK 的真实能力：会话创建/恢复、事件格式、审批/拒绝流程、取消运行、工作目录约束和非交互调用方式。优先使用有文档支持的接口；不得依赖未经验证的内部文件格式或模拟私有协议。
- 定义 `CodexAdapter` 接口，把客户端 API 与具体 CLI/SDK 解耦。adapter 负责启动或连接 Codex、映射事件、提交用户消息、取消任务、转交审批决定，并管理子进程生命周期。
- 如官方接口不能稳定提供某项能力，明确标记为暂不支持；不要为了复刻 Claude 功能而伪造 Codex 权限事件。
- 初期可使用 SQLite 保存设备配对、会话索引和事件序号；敏感令牌应做哈希或使用系统凭据存储，禁止写入日志。
- 默认仅绑定 `127.0.0.1` 或明确选择的私有 LAN 网卡；不默认公开绑定所有接口。暴露到 LAN 时要求配对令牌、TLS 或经评估的安全传输配置，并提供撤销设备能力。

### Android 客户端

- Flutter / Dart，按 feature 划分 pairing、projects、sessions、chat/events、approvals、settings。
- REST 用于配对、项目/会话列表和历史补齐；WebSocket 用于实时事件和交互命令。
- 令牌存储在 Android Keystore 支持的安全存储中；日志、崩溃报告和剪贴板不得包含令牌或会话敏感内容。
- UI 清晰区分生成中、等待用户审批、完成、失败、已断连等状态；重连后用服务端序号补齐遗漏事件，客户端对事件幂等处理。

## 协议草案

版本化 JSON 消息。每个服务端事件包含 `protocolVersion`、`eventId`、`seq`、`sessionId`、`timestamp`、`type` 和 `payload`。建议首批事件：

- `session.created`、`session.status`
- `message.started`、`message.delta`、`message.completed`
- `plan.updated`
- `tool.started`、`tool.output`、`tool.completed`（仅发送 UI 必要摘要，避免泄露环境变量/密钥）
- `approval.requested`、`approval.resolved`（仅当 Codex adapter 确认底层支持）
- `session.error`、`connection.heartbeat`

客户端命令包括 `session.create`、`session.resume`、`message.send`、`session.cancel`、`approval.respond`。每个有副作用的命令携带唯一 `requestId`，服务端鉴权、校验项目目录和会话归属，并对重复 request 去重。断线恢复使用 `lastSeq` 请求补发；若缓冲区不够则通过 REST 拉取快照/历史。

协议必须先写成共享 schema（建议 JSON Schema），并用同一组样例驱动 server 与 Flutter 的序列化测试。

## 开发阶段与交付物

### Phase 0：Codex 能力验证（先做）

- 在目标 Windows 环境核实 Codex CLI 安装、版本和官方支持的集成方式。
- 写一个最小实验，验证启动/恢复会话、接收流式事件、发送消息、取消，以及是否存在结构化审批请求与响应接口。
- 输出 `docs/codex-capability-matrix.md`，逐项注明证据、限制和是否进入 MVP。此阶段通过后再固定 adapter 设计。

### Phase 1：协议与服务端骨架

- 建立 workspace、配置、日志脱敏、配对认证和健康检查。
- 实现 `CodexAdapter` mock 与契约测试，WebSocket 序号/重连/去重。
- 不连接真实 CLI 前，先用 mock 验证事件流和断线恢复。

### Phase 2：真实 Codex adapter

- 按 Phase 0 结论实现最小会话生命周期与消息流。
- 明确进程隔离、超时、取消、退出码、输出限额和清理策略。
- 审批只接入底层真实支持的机制；不能把普通工具事件当作审批。

### Phase 3：Flutter MVP

- 配对、项目列表、会话列表、聊天流、运行状态、审批卡片（若支持）、连接设置。
- 添加加载/空/错误/断连状态和基本无障碍支持。

### Phase 4：端到端验证与打包

- Windows 本机和 Android 真机配对；覆盖断网重连、服务重启、过期令牌、重复命令、拒绝审批和进程异常退出。
- 输出 Windows 安装/启动说明、Android debug APK 构建说明及威胁模型。
- 评估是否加入 TLS、二维码配对和后台通知；公网访问需单独设计，不沿用裸 LAN token 方案。

## 建议仓库结构

```text
server/                 # Node.js + TypeScript companion server
  src/modules/auth/
  src/modules/projects/
  src/modules/sessions/
  src/modules/codex/
  src/modules/events/
  src/protocol/
app/                    # Flutter Android client
  lib/features/pairing/
  lib/features/projects/
  lib/features/sessions/
  lib/features/chat/
  lib/features/approvals/
packages/protocol/       # JSON Schema + fixtures / generated types
docs/
  codex-capability-matrix.md
  threat-model.md
  protocol.md
```

目录是建议，开发 agent 可在保持边界清晰的前提下调整；不要一开始复制整个 CloudCLI 或 Claude-Flutter 仓库。

## 安全要求

- 访问令牌等同于电脑上 Codex 控制权限，配对、传输、存储、撤销和日志脱敏都按高敏凭据处理。
- 初始配对应在电脑本地确认或使用短时一次性配对码；不能只靠局域网可达就授予控制权。
- 每次命令都校验 token、设备、session 和项目目录；路径规范化后限制在用户明确配置的 workspace 根目录。
- 服务端绝不提供未受限的通用 shell API。Codex 工具权限继续由 Codex 自身的策略/沙箱处理。
- 默认不监听公网，不开放路由器端口，不内置云端中转。远程互联网访问须另行设计端到端加密、设备撤销和重放防护。
- 不记录 API key、访问令牌、完整环境变量或可能含秘密的原始工具输出。

## 给开发 Agent 的执行指令

1. 先阅读本 README 和 `docs/`，然后完成 Phase 0 的能力验证；把事实和推断分开记录并引用官方文档/本机命令结果。
2. 验证完成后，提出最小可行的 `CodexAdapter` 契约与协议 schema，再开始服务端实现。
3. 每阶段独立提交，保持 app/server/protocol 可分别运行；不要把令牌或个人机器路径提交到 Git。
4. 先构建 mock 驱动的垂直切片，再接真实 Codex；每次声称完成的功能都需说明实际验证范围。
5. 如发现 Codex 当前不支持某个预期能力，更新能力矩阵和范围，不得用未经确认的模拟流程掩盖限制。

## 参考项目

- [CloudCLI](https://github.com/cheng1212/CloudCLI)：自托管 Web 控制台，包含会话、编辑器、终端、Git 和任务看板。
- [Claude-Flutter](https://github.com/cheng1212/Claude-Flutter)：Flutter Android + 桌面 companion server 的远程 agent 控制项目。本项目借鉴其分层和移动端交互思路，Codex 接入必须单独验证。

## License

License 暂未确定。实现开始前由仓库维护者选定；不要默认复制参考仓库的许可证或代码。
