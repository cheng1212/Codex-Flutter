# Codex 能力矩阵（Phase 0 草案）

> 状态：草案，供第 1 批提交审核。只含调研结论，不含实现代码。
> 调研日期：2026-11-12（UTC 15:05–15:07 抓取官方文档；CST 23:05–23:15 本机验证）。
> 基线版本：本机 `codex-cli 0.164.0-alpha.9`（Linux）；`@openai/codex-sdk` npm 最新稳定版 `0.167.2`（同期 alpha 已到 `0.170.0-alpha.2`）。
> 目标环境：README 指定的 Windows 真机**本次未验证**，见 §5 限制。

## 0. 一句话结论

- **主路线已证实：`codex app-server`（JSON-RPC，长驻进程）**——建线程、恢复、发消息、流式事件、取消、会话列表/历史、**结构化审批请求与响应**全部有官方文档 + 本机实测支撑。
- **审批（README MVP 第 5 条）只能走 app-server**：`codex exec --json` 与 TypeScript SDK（`@openai/codex-sdk`）的事件流里**没有审批请求事件**，也没有"等用户在手机上点批准再继续"的回调接口，只能用预设策略（`--ask-for-approval` / `--approve-for-me` / `--dangerously-bypass-approvals-and-sandbox`）事先定好，**不能照搬 Claude-Flutter 的审批卡片模式**。
- **Phase 1 可以按蓝图开工，但只做 app-server 路线的骨架 + mock**；真实 Codex 接入（Phase 2）前必须在 Windows 真机上复核 §5 的未验证项，尤其是原生沙箱、登录认证和一次真实 turn。

## 1. 本机环境结论（Linux 云主机，Ubuntu 24.04.5 LTS）

| 工具 | 结果 | 结论 |
|---|---|---|
| `codex --version` | `codex-cli 0.164.0-alpha.9` | 有。注意是 **alpha 版**，比官方文档提到的 0.166.0 稳定版旧；Windows 目标机应装最新稳定版，不以这个 alpha 为准 |
| `node --version` | `v24.22.1` | 有，满足 README 要求的 Node.js 20+ |
| `npm --version` | `10.9.4` | 有 |
| `flutter --version` | `command not found` | 无。本机做不了 Flutter 编译/分析，Phase 3 需在有 Flutter 的机器（或 Windows 目标机）上做 |
| `dart --version` | `command not found` | 无，同上 |
| `~/.codex/auth.json` | 不存在；`~/.codex/config.toml` 也不存在；`OPENAI_API_KEY` / `CODEX_API_KEY` 均未设置 | **本机无任何 Codex 登录凭证**，因此未做、也做不了真实模型调用；所有"跑起来"的验证只到协议层为止 |
| `codex app-server` 探针 | 见 §3 | 未登录也能启动并响应 `initialize` / `thread/list`（空列表） |

补充：本机 `bubblewrap` 不在 PATH，app-server 启动时报 `configWarning`，称"将使用内置 bubblewrap"。Linux 沙箱属于降级路径，不影响结论，但 Windows 上沙箱实现完全不同（见 §5）。

## 2. 两条官方集成路线对比（已证实）

|  | A. `codex app-server`（推荐主路线） | B. `codex exec` / TypeScript SDK（备选） |
|---|---|---|
| 形态 | 长驻进程，JSON-RPC 2.0（stdio 默认；另有 ws / unix socket）；官方定位"给富客户端（VS Code 扩展）用的深集成接口" | 每轮一个子进程；`codex exec --json` 输出 JSONL 事件流；TS SDK（`@openai/codex-sdk`）就是对它的封装："spawns the CLI and exchanges JSONL events over stdin/stdout"，Node.js 18+，仅服务端用 |
| 会话 | `thread/start`、`thread/resume`、`thread/fork`、`thread/list`、`thread/read`、`thread/turns/list`、`thread/items/list`、`thread/archive/delete/unarchive` | `codex exec "…"` 新建；`codex exec resume <id\|--last> "…"` 恢复；SDK：`codex.startThread()` / `resumeThread(id)` / `thread.run()` / `runStreamed()` |
| 流式事件 | 通知：`turn/started`、`item/started`、`item/agentMessage/delta`、`item/completed`、`turn/completed` 等 | JSONL：`thread.started`、`turn.started`、`item.started/updated/completed`、`turn.completed/failed`、`error`；item 类型含 agent_message、reasoning、command_execution、file_change、mcp_tool_call、web_search、todo_list（官方非交互文档 + SDK `index.d.ts` 一致） |
| 审批 | **有**结构化请求/响应（见 §4） | **无**。事件流无审批事件；只有启动前预设的 `approvalPolicy`（SDK `ThreadOptions.approvalPolicy`）和 `--ask-for-approval` |
| 取消 | `turn/interrupt` → turn 以 `status: "interrupted"` 结束 | SDK：`TurnOptions.signal: AbortSignal`；`exec` 本身无"取消进行中 turn"的命令，只能杀进程（未验证，见 §5） |
| 进行中追加消息 | `turn/steer`（追加到在途 turn）；CLI 另有 `codex queue --thread <id> --message <text>` | 无。`run()` 必须等上一轮结束 |
| 适用 | companion server 的 Codex 层 | CI/一次性任务；Phase 1 的 mock 契约对照物；不适合做 MVP 的交互式远程控制 |

来源：官方 SDK 页（https://developers.openai.com/codex/sdk，2026-11-12 抓取）、官方 App Server 页（https://learn.chatgpt.com/codex/app-server，同日抓取）、官方非交互模式页（https://developers.openai.com/codex/noninteractive/，同日抓取）、本机 `codex --help` / `codex exec --help` / `codex app-server --help`（0.164.0-alpha.9）、npm `@openai/codex-sdk@0.167.2` 的 `README.md` 与 `dist/index.d.ts`（/tmp 解包检查，未写入仓库）。

## 3. 本机实测证据（2026-11-12，Linux，未登录）

用 Python 以 stdio 方式拉起 `codex app-server`，依次发 `initialize` → `initialized` → `thread/list`（另发了 `model/list`，但探针在收到回复前就关闭了 stdin，未收到结果，见未验证项）：

- `initialize` 正常返回：`userAgent: "codex-flutter-phase0-probe/0.164.0-alpha.9 (Ubuntu 24.4.0; x86_64) …"`，`platformFamily: "unix"`，`platformOs: "linux"`，`codexHome: "/home/hatch/.codex"`。
- `thread/list` 正常返回空列表：`{"id":1,"result":{"data":[],"readStates":{},"nextCursor":null,"backwardsCursor":null}}`。
- 附带收到两条通知：`configWarning`（缺 bubblewrap）和 `remoteControl/status/changed`（`status: "disabled"`，含 `serverName` 与 `installationId`）。
- 另用 `codex app-server generate-json-schema --out /tmp/codex-schema-0.164.0-alpha.9` 成功生成 39 个 JSON Schema 文件（4.5 MB），其中审批相关 8 个（见 §4）。这是**版本精确**的协议证据，Phase 1 生成 TypeScript 类型应以同版本命令输出为准，而不是手抄文档。
- 反向证据：`codex exec --json …` 试跑未得到模型输出（本机无认证，且该命令在探针环境下表现为等待 stdin 输入）。**这不是"exec 不可用"的证据**，只说明无凭证时无法完成真实 turn。

## 4. 能力矩阵

图例：✅ 已证实（官方文档 + 本机或包内证据）｜ ⚠️ 部分证实/有限制 ｜ ❌ 该路线不支持 ｜ ❓ 未证实（需 Windows 真机或登录后验证）

| # | 能力 | 结论 | 证据与要点 | 限制 | 进 MVP？ |
|---|---|---|---|---|---|
| 1 | 新建会话/线程 | ✅ | app-server `thread/start`（返回 `thread.id`）；SDK `startThread()`；`codex exec "…"` | app-server 的 thread 持久化在 `~/.codex/sessions`，由服务端管理，客户端只存 id | 是 |
| 2 | 恢复/继续会话 | ✅ | app-server `thread/resume`（按 id）；SDK `resumeThread(id)`；`codex exec resume <id>` / `--last`（`--all` 跨目录）；官方文档注明 CLI 0.166.0+ 恢复时要用线程保存的模型 provider，换 provider 应 `fork` | `--last` 只取当前目录最新会话；恢复不存在的 id 的行为未验证 | 是 |
| 3 | 发送文本消息 | ✅ | app-server `turn/start`（`threadId` + `input: [{type:"text",…}]`）；SDK `thread.run("…")` / `runStreamed()`；`exec` 位置参数或 stdin（`codex exec -` 全文作 prompt；提示词+管道 stdin 作上下文） | 图片输入仅 SDK（`local_image`）与 app-server 的 input 项支持；MVP 只做文本 | 是 |
| 4 | 进行中追加消息 | ⚠️ 仅 app-server | app-server `turn/steer`（返回接受的 `turnId`）；CLI `codex queue --thread <id> --message <text>`（面向 daemon 会话） | `turn/steer` 在手机弱网/断线重连时的语义、与 `turn/interrupt` 的竞态未验证；SDK/exec 无此能力 | 否（MVP 不做；Phase 2 后视需要加） |
| 5 | 流式呈现 assistant 输出 | ✅ | app-server `item/agentMessage/delta` 通知；`exec --json` 的 `item.started/updated/completed`（`agent_message`）；SDK `runStreamed()` 的 async generator 事件 | `exec --json` 的 delta 粒度（`item.updated` 何时发）未实测；以 app-server 为准 | 是 |
| 6 | 工具调用摘要事件 | ✅ | app-server `item/started/completed`（`commandExecution`、`fileChange`、`mcpToolCall` 等）；`exec --json` 同类 item 事件 | 第三方资料称 `mcp_tool_call` 的 JSONL 事件不含工具参数/结果（GitHub issue #5028 所述，官方文档未确认）——MVP 只展示摘要，不依赖参数/结果，不受影响 | 是（仅摘要） |
| 7 | 待办/计划事件 | ✅ | `todo_list` item 类型（官方非交互文档列出；SDK `TodoListItem` 类型亦有；app-server 文档的 item 类型体系一致） | 计划的展示形态（todo 明细字段）以 app-server 生成的 schema 为准，Phase 1 再核对 | 是（映射为 `plan.updated`） |
| 8 | 取消运行 | ✅（app-server）；⚠️（SDK）；❓（exec） | app-server `turn/interrupt` → `turn/completed`（`status: "interrupted"`），官方文档明确；SDK `TurnOptions.signal: AbortSignal`（类型定义证实，行为未实测） | `exec` 无取消命令；杀进程的退出码/残留会话状态未验证；取消后能否立即在同一线程开新 turn 未验证 | 是（app-server 路径） |
| 9 | 结构化审批：命令执行 | ✅（app-server）；❌（SDK/exec） | app-server 服务端请求 `item/commandExecution/requestApproval`，字段：`itemId`、`threadId`、`turnId`、可选 `reason`、`command`、`cwd`、`commandActions`、`proposedExecpolicyAmendment`、`networkApprovalContext`、`availableDecisions`；客户端回 `accept` / `acceptForSession` / `decline` / `cancel` / `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment`；随后 `serverRequest/resolved` + `item/completed`（`status: completed\|failed\|declined`）。本地生成的 `CommandExecutionRequestApprovalParams.json` / `…Response.json`（0.164.0-alpha.9）与文档一致 | `availableDecisions` 决定了手机端能给哪些按钮，**必须按请求里带的值渲染，不能写死四个按钮**；`networkApprovalContext` 出现时是"管制网络访问"审批，要单独渲染 host/protocol，不能当普通命令展示；`acceptForSession` 与 execpolicy/network 修正是持久化授权，手机端默认只给"本次批准/拒绝"，其余选项须经审核确认后再开放 | 是（核心，见 §6） |
| 10 | 结构化审批：文件修改 | ✅（app-server）；❌（SDK/exec） | `item/fileChange/requestApproval`（`itemId`、`threadId`、`turnId`、可选 `reason`、`grantRoot`）；回 `accept` / `acceptForSession` / `decline` / `cancel`；本地 `FileChangeRequestApprovalParams.json` 一致 | `grantRoot` 在 schema 里标注 `[UNSTABLE]`（"是否生效尚不明确"），**不得向用户承诺"批准后整会话可写该目录"** | 是 |
| 11 | 结构化审批：权限授予 / MCP / 工具提问 | ✅（app-server） | `item/permissions/requestApproval`（内置 `request_permissions` 工具发起；回授予的子集，`scope: "session"` 可跨 turn 持久化）；`mcpServer/elicitation/request`（表单/URL 两种）；`tool/requestUserInput`（1–3 个短问题，`autoResolutionMs` 超时可自动裁决）；MCP 工具审批（`Accept` / `Decline` / `Cancel`，带破坏性标注的必审） | 这三类在 MVP 里**先只做透传展示，不做自动裁决**；`autoResolutionMs` 的自动裁决默认关闭；MCP 相关能力取决于用户本机配置的 MCP server，MVP 默认不启用 | 否（MVP 只接 #9/#10；其余进 Phase 2 评估） |
| 12 | 审批（TS SDK / exec 路线） | ❌ 无交互审批 | SDK 事件联合类型 `ThreadEvent` 只有 `thread.started` / `turn.*` / `item.*` / `error`，无审批事件、无回调钩子；`exec --json` 官方列出的事件类型同样无审批 | 只能事先设策略：`approvalPolicy: "on-request"|"never"`（SDK 类型里还列出已退役的 `on-failure` / `untrusted`，本机 CLI 0.164 的 `--ask-for-approval` 只剩 `on-request` / `never`——**以 CLI 实测为准，SDK 类型超前/滞后**）；`--full-auto` 已废弃，官方文档明确要求改用 `--sandbox workspace-write` 或 `--approve-for-me`；`--dangerously-bypass-approvals-and-sandbox`（`--yolo` 别名已不在 0.164 help 里）**禁止在 companion server 默认使用** | 否 |
| 13 | 会话列表 / 历史读取 | ✅（app-server）；⚠️（文件直读） | app-server `thread/list`（分页）、`thread/turns/list`、`thread/items/list`、`thread/read`，本次探针已证实 `thread/list` 未登录可返回空列表 | **不要直接读 `~/.codex/sessions/**/*.jsonl` 与 `session_index.jsonl`**：那是内部 rollout 格式，官方未承诺稳定。CloudCLI 现有代码就是这么读的（参考用，Codex-Flutter 不学这一点） | 是（app-server 路径） |
| 14 | 工作目录约束 | ✅ | `exec`：`-C/--cd <DIR>` 指定工作根；`--add-dir` 追加可写目录；默认要求 Git 仓库（可用 `--skip-git-repo-check` 关掉）；SDK：`workingDirectory` / `additionalDirectories` / `skipGitRepoCheck`；app-server `turn/start` 可覆盖 working directory 与 sandbox | companion server 必须在**自己的配置层**再做一次白名单校验（只允许用户明确配置的项目根目录，规范化路径防 `..` 穿越），不能只信 Codex 的 `-C` | 是 |
| 15 | 沙箱模式 | ✅ | 三档：`read-only`（`exec` 默认；仅读）/ `workspace-write`（工作区内读写，默认无网络）/ `danger-full-access`（无限制，仅隔离环境用）。执行层由 OS 机制强制 | Windows 原生沙箱实现（`mxc` / `elevated` / `unelevated`）与 Linux 的 bubblewrap 不同，**目标机实测前不得假定行为一致**；app-server 另有 `windowsSandbox/readiness` / `setupStart` 方法，见 §5 | 是（默认 `workspace-write` + `on-request`，即旧 `--full-auto` 的等价组合，但要显式配置） |
| 16 | 认证方式 | ✅（机制）；❓（本机未登录） | 两种：ChatGPT 登录（`codex login`，凭证存 `~/.codex/auth.json`，官方文档称"当密码对待"）或 API key（`CODEX_API_KEY`，仅对单次调用设置；`OPENAI_API_KEY` 亦可；`codex exec` 默认复用已保存的 CLI 认证）。SDK：`new Codex({ apiKey })` 或环境变量；app-server 启动时走托管认证路径 | **companion server 绝不代存/代传用户的 `auth.json` 或 API key 到手机**；手机只持有 companion 配对令牌，Codex 认证留在电脑本地；Windows 上 `auth.json` 位置为 `%USERPROFILE%\.codex\auth.json`，待复核 | 是（机制进 MVP；具体登录流程不由手机端处理） |
| 17 | 模型列表 | ❓ 未证实 | app-server 有 `model/list`（可返回可用模型、reasoning effort、默认模型），官方文档有示例 | 本次探针发了 `model/list` 但未等到返回（探针脚本在收到回复前关闭了 stdin）；模型可用性取决于登录账号/plan（如文档示例的 `gpt-6.1-sol` 需账号有权限）。MVP 不做模型选择器，Phase 2 再验证 | 否 |
| 18 | 非交互调用（exec） | ✅ | `codex exec "任务"`；`--json` 输出 JSONL；`--output-last-message` / `--output-schema`（结构化终态输出）；`--ephemeral`（不落盘会话）；stdin 管道模式 | 一次 `exec` = 一轮任务、进程结束即会话落盘；**不适合做"常驻远程控制"的底层**，只适合单次任务/CI；`exec` 的 turn 没有"进行中可交互"的概念 | 否（不当主路线） |
| 19 | 远程配对（Codex 自带） | ❓ 未证实 | 本机 0.164.0-alpha.9 自带**实验性**命令 `codex remote-control start/stop/pair`（`pair` 打印短期手动配对码）；`codex --remote ws://…` 可把 TUI 连到远程 app-server；app-server 的 `--listen ws://IP:PORT` 支持 `--ws-auth capability-token` / `signed-bearer-token`，另有 `GET /readyz` / `/healthz` 探针 | 配对码的协议、有效期、作用域在官方文档中**未找到说明**；`remote-control` 是给"远程 TUI"用的，不是给第三方 Flutter 客户端的公开 API；app-server 的 WebSocket 传输在官方文档中标注 **experimental and unsupported**，且"非 loopback 监听默认允许未认证连接"，暴露到 LAN 前必须配 `--ws-auth` + TLS | **否（MVP 不依赖它）**。蓝图的"一次性配对码 + 高熵令牌"由 companion server 自己实现；Phase 2 再评估是否复用 `remote-control` 的配对原语 |
| 20 | Windows 原生运行 | ❓ 未证实（本机是 Linux） | 二手资料转述官方文档（2026-10 月核对）：Windows 有原生 PowerShell 安装器（`irm https://chatgpt.com/codex/install.ps1 | iex`），不再强制要求 WSL；Windows 11 为推荐基线，Win10 1809+ 为 best effort；原生沙箱默认，WSL2 仅在需要 Linux 工具链时选用；WSL1 自 0.115 起不再支持 | 以上均来自第三方指南对官方文档的转述，**本次未直接打开官方 Windows 安装页核对**；Windows 真机上的安装路径、沙箱（`mxc` 需 Win11 24H2 特定 build）、`%USERPROFILE%\.codex` 位置、`codex.exe` 的 DLL 搜索加固（CloudCLI 的 codex-runtime 里有相关处理）都必须在目标机复核 | 是（目标平台；但首次验证必须在 Windows 上重做 §3 的探针） |
| 21 | Flutter / Dart 构建 | ❌ 本机无 | 本机 `flutter` / `dart` 均 `command not found` | Phase 3 的 app 构建与 `flutter analyze/test` 需在装有 Flutter SDK 的机器上进行；Claude-Flutter 的经验是 Windows 上用 `D:\flutter\bin\flutter.bat`，本项目是否沿用其 Flutter 版本/ channel 待定 | Phase 3 |
| 22 | 断线重连 / 事件补齐 | ⚠️ 需 companion 自实现 | app-server 协议本身**没有蓝图里写的全局 `seq`**；但有 `thread/items/list`（分页读历史）可做快照补齐；`thread/loaded/list` 可查内存中已加载线程 | 蓝图的 `seq` / `lastSeq` / 幂等去重必须由 companion server 自己实现（事件入库 + 自增序号 + 重连后按 `lastSeq` 补发，缓冲区不够时走 REST 快照）。这是**推断**，不是 Codex 提供的能力 | 是（companion 层实现） |

## 5. 未验证项与限制清单（Phase 2 前必须逐项消除）

1. **Windows 真机全套复核**：原生安装、版本（以稳定版为准，不用 0.164.0-alpha.9）、`app-server` stdio 探针（同 §3 的脚本在 PowerShell/Windows 下重跑）、沙箱 `mxc`/`elevated`/`unelevated` 在目标机上的实际表现、`windowsSandbox/readiness` 返回值。
2. **登录后真实 turn**：任一账号登录后，跑一次 `turn/start` 全流程——建线程、发消息、收 `item/agentMessage/delta`、工具调用、一次真实审批请求（命令执行 + 文件修改各一次）并经客户端回 `accept`/`decline`，确认往返时序与 `serverRequest/resolved` 的出现顺序。
3. **`turn/interrupt` 与 `turn/steer` 的竞态**：取消后立即发新 turn、steer 后立即 interrupt 的行为。
4. **`model/list` 与模型选择**：探针未收到返回；默认模型、可用模型与账号 plan 的关系未验证。
5. **`codex remote-control pair` 的协议细节**：配对码格式、有效期、能否被第三方客户端使用；官方文档未说明，需读 `openai/codex` 源码或实测后才能定。
6. **`exec` 进程级取消**：杀进程后的退出码、会话落盘状态（是否会产生半截 turn）。
7. **app-server 版本漂移**：`generate-json-schema` 的输出是版本绑定的；companion 必须在启动时校验 `codex --version`，版本不符时拒绝启动并提示升级，禁止静默按旧 schema 跑。

## 6. 最小可行的 CodexAdapter 契约草案（要点，非实现）

路线定为 **app-server over stdio**；TS SDK / `exec` 只作为降级对照，不进入 MVP 的 adapter。

```typescript
// 草案：server/src/modules/codex/adapter.ts（Phase 1 再落到代码）
// 进程模型：companion（Node.js）以 stdio 拉起 `codex app-server` 子进程，
// 全程 JSON-RPC 2.0（省略 "jsonrpc":"2.0" 头，见官方文档）；
// companion 是唯一接触 Codex 进程的一层，手机端只与 companion 的 REST+WSS 说话。
interface CodexAdapter {
  start(): Promise<void>;                    // 拉起 app-server，initialize 握手，校验 codex --version
  stop(): Promise<void>;                     // 优雅关闭子进程
  listThreads(opts: { limit?: number; cursor?: string | null }): Promise<ThreadSummary[]>;
  createThread(opts: { cwd: string; model?: string }): Promise<ThreadSummary>;   // thread/start
  resumeThread(threadId: string): Promise<ThreadSummary>;                        // thread/resume
  readThread(threadId: string): Promise<ThreadDetail>;                           // thread/read + turns/items/list
  startTurn(threadId: string, input: string): Promise<TurnHandle>;               // turn/start
  interruptTurn(threadId: string, turnId: string): Promise<void>;                // turn/interrupt
  respondApproval(req: ApprovalRequest, decision: ApprovalDecision): Promise<void>;
  on(event: "codex-event", cb: (e: CodexEvent) => void): void;                   // 向事件总线转发
}
```

关键设计约束（来自矩阵）：

- **只暴露稳定 API**：`initialize` 时不设 `experimentalApi: true`（除非 Phase 2 明确需要某个实验方法并经审核）；实验方法/字段被服务端拒绝时要当错误处理，不得静默降级。
- **审批是服务端请求（server-initiated JSON-RPC request），不是通知**：adapter 必须按 JSON-RPC 的 `id` 配对响应；手机端回 `accept`/`decline` 只是 MVP 起步；`acceptForSession`、execpolicy 修正、网络策略修正**默认不开放**，需单独评审。
- **审批请求必须带 `threadId`/`turnId` 作用域**：UI 状态按 thread+turn 挂；超时/断连/turn 结束时，未答复的请求按"已清除"处理（服务端会发 `serverRequest/resolved`），不得让手机端对着已失效的请求点批准。
- **事件映射只做摘要**：`item/agentMessage/delta` → `message.delta`；`item.started/completed`（command_execution / file_change / todo_list）→ `tool.*` / `plan.updated`；原始工具输出、环境变量、密钥**不进事件 payload**，更不进日志。
- **进程与版本管理**：启动时记录 `codex --version`；app-server 退出/崩溃要能重连并重建订阅（`thread/loaded/list` 恢复在途线程状态）；`generate-json-schema` 的输出作为 Phase 1 的类型生成输入，签入 `packages/protocol/`（或 server 内），并注明生成所用的 CLI 版本。
- **绝不做的事**：不直接读 `~/.codex/sessions` 的 rollout 文件；不把 `auth.json` / API key 发给手机；不默认 `--dangerously-bypass-approvals-and-sandbox`；不把 app-server 的 ws 监听直接暴露到 LAN（companion 自己做配对认证 + WSS，再用 stdio/unix socket 连本地 app-server）。

## 7. 参考库只读结论（未复制代码）

- **Claude-Flutter**（`~/workspace/Claude-Flutter`，浅克隆，默认分支 `develop`，最新 `981853f`）：server 用 Fastify + `ws` + `better-sqlite3`，通过 `@anthropic-ai/claude-agent-sdk` 的 `query()` 流式驱动 Claude，审批用 `canUseTool` 回调 + `PendingEntry`（resolve 保留详情，重启后可重建审批卡）。**可借鉴的是分层与审批挂起机制的设计思路，不可借鉴的是 SDK 本身**——Codex 没有对等的 `canUseTool` 回调，审批要走 app-server 的服务端请求。
- **CloudCLI**（`~/workspace/CloudCLI`，浅克隆）：server 已有 `codex` provider（含 `@openai/codex-sdk@^0.146.0` 的 `codex-runtime.provider.js`），并直接读 `~/.codex/sessions/**/*.jsonl` 做标题查找。**两点教训**：① 其 SDK 版本（0.146.0）已落后于当前 0.167.2；② 直接读会话文件的路子在 Codex-Flutter 里不采用（见 #13）。
- 两个参考库的 Windows 工作树约定（Claude-Flutter 的 `D:\WorkSpace\Claude Code Flutter`、server 端口 5190/5191）与本项目无关，Codex-Flutter 的端口与目录按自己的蓝图定。

## 8. 事实与推断分界

**事实**（有来源）：§2–§4 表格中标 ✅ 的行，来源为官方文档页（2026-11-12 抓取）、本机 `--help` 输出、npm 包内文件、本地生成的 JSON Schema、本机 stdio 探针输出。

**推断**（需验证）：

- "companion 用 stdio 连本地 app-server、再向 LAN 暴露自己的 WSS"是最安全的拓扑——这是基于 app-server 文档中"WebSocket 传输 experimental and unsupported，且非 loopback 默认允许未认证连接"的**设计判断**，不是官方推荐。
- 蓝图的 `seq`/`lastSeq` 由 companion 自实现——app-server 协议没有全局序号是事实，但"用 `thread/items/list` 做快照补齐足够"的说法是**推断**，需 Phase 1 的断线重连测试证实。
- Windows 侧的全部内容目前只有二手转述——见 §5 第 1 条。

## 9. Phase 1 开工建议

- **可以开工**：协议与服务端骨架（配对认证、健康检查、REST+WSS、事件总线、序号/重连/去重、SQLite 会话索引）+ `CodexAdapter` 的 **mock 实现与契约测试**，全部不依赖真实 Codex。
- **开工条件**：先把 `codex app-server generate-json-schema`（与目标机 CLI 同版本）的输出作为类型生成输入；mock 事件必须按 §4 的真实事件名（`thread.started` / `item/agentMessage/delta` / `turn/completed` / `item/commandExecution/requestApproval`）造，不得自创事件名。
- **风险**：
  1. 版本漂移：Codex CLI 迭代极快（0.164 alpha → 0.166 稳定仅数周），`--full-auto` 说废就废；adapter 必须做版本校验与 schema 再生成。
  2. 审批是 MVP 最大的不确定点：真实审批请求的出现时机取决于用户的 `approvalPolicy` 与沙箱配置；默认 `workspace-write` + `on-request` 下，读操作不审、写操作与网络才审——手机端长时间收不到审批请求是**正常现象**，不是 bug。
  3. Windows 沙箱是最大未知数：`mxc` 需要特定 Win11 build，老机器会回落到 `elevated`/`unelevated`，行为差异要在目标机实测。
  4. 认证不在手机端：用户须先在电脑上 `codex login`（ChatGPT 账号）或配好 `CODEX_API_KEY`，companion 才能工作；这是部署前置条件，不是代码能解决的。
