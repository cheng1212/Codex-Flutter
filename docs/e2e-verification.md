# 端到端验证（Phase 4）

> 日期：2026-11-12。结论先说：**本地能跑的都跑过且全通过；真机与
> 真实 Codex 相关的全部未做**，清单在 §2，遇到不支持的能力就更新
> 矩阵与范围，不用模拟流程掩盖限制。

## 1. 本机已跑过的验证（真实结果，只报跑过的）

| # | 验证 | 命令 / 做法 | 结果 |
|---|---|---|---|
| 1 | Phase 1 契约测试 | `cd server && npm test` | 13/13 通过（配对、序号/重连补齐、快照回退、重复 requestId 去重、审批 availableDecisions 校验、过期审批清除、cwd 白名单、日志脱敏、心跳） |
| 2 | Phase 2 真实 adapter 测试（fake app-server stub） | 同 `npm test` | 15/15 通过，合计 **28/28，0 失败**（约 9–10 秒）。覆盖：initialize 握手、thread/start/resume/list/read、turn/start 流式 delta、三类审批（command/file/permissions）accept/decline、turn/interrupt、单次 RPC 超时、turn 空闲超时、进程崩溃重连、版本门（0.164.0-alpha.9 低于 0.166.0 时拒绝启动） |
| 3 | 服务端冒烟（mock） | `npm start` → `GET /healthz`、`POST /api/v1/pairing/code` | healthz 返回 `{"status":"ok","protocolVersion":"1.0.0","codex":{"mode":"mock","script":"approval-basic"}}`；6 位配对码正常签发（5 分钟有效） |
| 4 | 服务端冒烟（real 模式版本门） | `CODEX_FLUTTER_CODEX_MODE=real npm start` | 明确拒绝启动，报错版本低于最低版 0.166.0——预期行为，不静默回落 mock |
| 5 | mock 端到端（配对→建会话→审批→断线重连） | Phase 1 契约测试内 + 手动冒烟 | 配对认领、建会话、流式 delta、审批 accept 后 turn 完成、WS 断线后按 lastSeq 补发全部事件、落后窗口回 snapshot-required 走 REST 快照——均在 mock + stub 层面通过 |
| 6 | Flutter 静态分析 | `cd app && dart analyze` | **No issues found!**（exit 0；Flutter 3.50.0，修订版 ab2912035e） |
| 7 | Flutter 测试 | `cd app && flutter test --no-pub` | **35/35 通过**（协议解析含 8 个 protocol fixtures、事件去重/乱序/水位、审批逻辑、审批卡片 widget 测试）。注意：本机沙箱里 Dart 的 TLS 在出口代理后挂死，删掉 `pubspec.lock` 后裸 `flutter test` 会先触发 `pub get` 解析依赖并挂起（已复现：两次后台运行均因确认超时被 SIGTERM 中断）；`--no-pub` 跳过解析、直接用已有的 `.dart_tool/package_config.json` 即可通过。在网络正常的机器上先 `flutter pub get` 重新生成锁文件再跑普通 `flutter test`。 |
| 8 | 无真实 Codex 引用核查 | `grep` server/src（Phase 1）+ 复核 real-adapter | Phase 1 的 server 内无 `child_process`/`spawn`/`codex exec`；Phase 2 的 real-adapter 是唯一拉进程的地方，只用 stdio，不读 `~/.codex/sessions`，不默认 `--dangerously-bypass-approvals-and-sandbox` |
| 9 | 审批驱动核查 | 契约测试 + widget 测试 | 未列出的决定返回 `decision-not-offered`；`acceptForSession` 即使被列出也被 `decision-not-allowed` 挡下；过期审批再答复返回 `approval-no-longer-pending`；Flutter 卡片只按 `availableDecisions` 渲染，过期显示已失效不可点 |

## 2. 必须在真机上补做的验证（未做清单）

以下每一项都要在目标环境跑完、把结果记回本文件与矩阵，**不得
用 stub/mock 结果代替**：

### Windows 目标机 + 真实 Codex（Phase 2 门槛）

- [ ] 原生安装：按 `docs/setup-windows-android.md` §1 装 Codex CLI，核
  对 `codex --version` ≥ 0.166.0，并核对官方 Windows 安装页（Phase 0
  的 Windows 信息目前只是二手转述）。
- [ ] Windows 沙箱：`mxc`/`elevated`/`unelevated` 在目标机上的实际
  表现；`windowsSandbox/readiness` 返回值；老机器回落后的行为差异。
- [ ] 登录后真实 turn：任一账号 `codex login` 后，跑一次完整
  `turn/start`——建线程、发消息、收 `item/agentMessage/delta`、
  工具调用、一次真实审批往返（命令执行 + 文件修改各一次），确认
  往返时序与 `serverRequest/resolved` 的出现顺序。
- [ ] `turn/interrupt` 与 `turn/steer` 竞态：取消后立即发新 turn、
  steer 后立即 interrupt 的行为（`turn/steer` 本身 MVP 不做，但
  interrupt 的语义必须验）。
- [ ] `model/list`：探针未收到返回；默认模型、可用模型与账号 plan 的
  关系未验证（MVP 不做模型选择器，验完再定）。
- [ ] `codex remote-control pair`：配对码格式、有效期、能否被第三方
  客户端使用（官方文档未说明；MVP 不依赖它，验完只作记录）。
- [ ] `exec` 进程级取消：杀进程后的退出码、会话落盘状态（是否产生
  半截 turn）。
- [ ] `availableDecisions` 字段：0.164.0-alpha.9 的 schema 里审批
  params 没有该字段（矩阵 §9），目标机新版 CLI 上核对有无该字段，
  再决定 adapter 的默认值逻辑是否保留。
- [ ] 版本漂移复核：用目标机 CLI 版本重新跑
  `codex app-server generate-json-schema`，比对协议 schema 是否
  需要更新。

### Android 真机 + companion server（Phase 3/4）

- [ ] debug APK 构建：本机无 Android SDK 未成功；有 SDK 的机器上跑
  `flutter build apk --debug`，确认产物可安装（applicationId
  `com.codexflutter.codex_flutter`）。
- [ ] 真机配对全流程：扫码/输地址 + 6 位码认领，令牌进 Keystore；
  错误配对码、过期配对码、重复认领均应拒绝。
- [ ] 断网重连：手机断网 → 恢复，事件按 `lastSeq` 补齐、无重复、
  无丢失；落后保留窗口时走 REST 快照。
- [ ] 服务重启：companion 重启后 `seq` 不回退，手机重连补齐；在途
  turn 按 interrupted 处理。
- [ ] 过期令牌：撤销设备后旧令牌的 REST 与 WS 一律 401。
- [ ] 重复命令：同一 `requestId` 发两次，服务端只执行一次（消息
  不发两次、审批不答两次）。
- [ ] 拒绝审批：手机上点拒绝后 turn 正常结束、事件流有
  `approval.resolved {declined}`；再点已失效卡片无反应。
- [ ] 进程异常退出：杀掉 `codex app-server` 子进程，companion 重连，
  手机端看到 `session.error` 与 interrupted 状态，不卡死。
- [ ] 插件真机通道：flutter_secure_storage / mobile_scanner /
  shared_preferences 的平台通道只在完整构建后才能验证。

## 3. 范围变更记录（Phase 2–4 实际发生的）

- `approval.requested` 增加 `permissions` 一种（矩阵 §4 #11 的
  权限授予类），协议版本号仍为 1.0.0；Flutter 卡片已接入该类审批
  的渲染。
- 0.164.0-alpha.9 的 schema 里审批 params 没有 `availableDecisions`
  字段——adapter 按可选字段处理，缺失时用安全默认值（矩阵 §9、
  协议文档已更新，目标机版本上再核对）。
- `pubspec.lock` 已删除：本机 `dart pub get` 走临时本地镜像代理
  生成，锁文件绑定了 `http://127.0.0.1:19090`，在别的机器上无法
  解析依赖；在网络正常的机器上直接 `flutter pub get` 重新生成
  （依赖版本见 `app/pubspec.yaml`）。不要把旧锁文件加回来。
- Flutter 3.50 起 Material 库在官方包 `material_ui`（1.11.0）里，
  `package:flutter/material.dart` 已废弃，app 已迁移（`dart analyze`
  零问题、`flutter test` 35/35）。
- 未发现 Codex 不支持、需要砍范围的能力。Phase 0 矩阵里标 ❌ 的
  （exec/TS SDK 无审批事件）已通过“只走 app-server”规避，不在
  MVP 范围内，不存在用模拟流程掩盖的限制。
