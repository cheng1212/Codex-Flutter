# 威胁模型（Codex-Flutter，Phase 4）

> 范围：MVP（Phase 0–4 交付物）。首版只做**可信局域网配对**，不做公网
> 中继、云端托管和账号体系。任何超出下述边界的用法（公网暴露、不可信
> Wi-Fi、共享电脑上的多用户）都需要重新评估，不在本模型覆盖内。

## 0. 资产与信任边界

| 资产 | 位置 | 敏感度 |
|---|---|---|
| Codex 控制权（可读写工作区、执行命令、改文件） | 用户自己的电脑，companion server 进程内 | 最高——拿到它等于拿到该电脑上的 Codex 权限 |
| 配对令牌（32 字节随机值） | 手机 Keystore；服务端只存 SHA-256 哈希 | 最高——等同于 Codex 控制权 |
| 一次性配对码（6 位数字，5 分钟） | 电脑屏幕显示、用户口头/扫码传给手机 | 高——短时有效，单次使用 |
| Codex 认证（`codex login` 的 `auth.json` / `CODEX_API_KEY`） | 只在电脑本地，companion 进程外 | 最高——companion **绝不**接收、存储、转发它 |
| 会话内容与工具输出摘要 | SQLite 事件表（`data/companion.db`）、手机内存 | 中——可能含代码与路径，**不得含密钥/完整环境变量** |
| 工作区源码 | 用户配置的 workspace 根目录 | 高——只允许白名单目录 |

信任边界：① 手机 App ↔ companion server（LAN，配对令牌 + 明文，
见 §3）；② companion server ↔ 本地 `codex app-server` 子进程
（stdio，本机）；③ companion server ↔ 工作区文件系统（白名单校验后
才交给 Codex）。**app-server 自身的 WebSocket 监听不在边界内**——
companion 只用 stdio 连它，绝不把它暴露到 LAN（其 ws 传输官方标注
experimental，且非 loopback 默认允许未认证连接）。

## 1. 攻击者模型

- **局域网窃听/中间人（可信 LAN 假设内不考虑，LAN 外必须考虑）**：
  首版协议不加密，假设 LAN 可信（家庭/办公室私有 Wi-Fi）。一旦
  LAN 不可信（公共 Wi-Fi、被入侵的路由器），令牌与会话内容可被
  抓包——因此**禁止把 server 暴露到公网或公共 Wi-Fi**，TLS 改造见 §6。
- **偷到手机的人**：令牌在 Android Keystore（`flutter_secure_storage`），
  不进剪贴板、不进日志、不进备份（须确认备份策略，见 §4）。手机解锁
  屏障是最后一道防线；发现手机丢失立即在电脑上撤销设备（见 §5）。
- **拿到配对码的人**：6 位码只有 5 分钟有效期、单次使用、只能在
  loopback 上创建，且认领时要同时知道服务器 LAN 地址。过期/用过
  的码一律拒绝。
- **恶意/被劫持的手机 App 客户端**：配对令牌只能做协议里的 5 种命令，
  不能绕过 workspace 白名单、不能调通用 shell、不能读 `auth.json`。
  损害上限是“以该用户身份操作已配置工作区里的 Codex”。
- **Codex 本身被诱导**：模型输出可能要求执行危险命令或改敏感文件。
  缓解在两层：① Codex 自身的 `approvalPolicy: on-request` +
  `sandbox: workspace-write`（真实 adapter 启动时显式传）；
  ② 审批必须经手机上的人逐条批准，且 `acceptForSession`、
  execpolicy/网络修正默认被服务端挡住（需显式开启）。
- **companion server 被入侵**：server 以用户身份运行，能调 Codex、
  能读白名单目录——损害与 Codex 控制权被盗相同。因此 server
  只能绑 `127.0.0.1` 或明确配置的私有 LAN 地址，`0.0.0.0` 默认
  不允许；不监听公网、不开路由器端口。

## 2. 逐项缓解（已实现）

| 威胁 | 缓解 | 位置 |
|---|---|---|
| 令牌泄露（日志/备份/剪贴板） | 只存 SHA-256 哈希；日志脱敏（令牌、API key 字段与 64 位十六进制串一律 `[redacted]`）；令牌不进剪贴板、不进界面；原始令牌只在认领时返回一次 | `server/src/logging.ts`、`db.ts`、`modules/auth/pairing.ts`、`app/lib/core/token_store.dart` |
| 配对码被猜/重放 | 6 位随机码、5 分钟过期、单次使用、loopbackonly 创建 | `modules/auth/pairing.ts`、`server.ts` |
| 未授权访问 REST/WS | 除 `/healthz` 与配对认领外全部要 Bearer 令牌；WS 握手时校验令牌 | `server.ts` |
| 路径穿越 / 越权工作区 | cwd 规范化 + 白名单 workspace 根目录，`..` 穿越拒绝；每次命令校验令牌、设备、session 归属 | `modules/projects/projects.ts`、`sessions.ts` |
| 重放命令（重复发消息/重复审批） | 每个有副作用的命令带唯一 `requestId`，服务端 SQLite 存已处理结果，重复直接回放，不再执行 | `server.ts`、`db.ts` |
| 审批被伪造/过期后仍可点 | 服务端逐条校验决定是否在该请求的 `availableDecisions` 内；已答复/过期/取消/turn 结束/断连的请求再答复返回 `approval-no-longer-pending`，adapter 不被调用；清除时 adapter 代答 decline（永不授权） | `modules/approvals/approvals.ts`、协议 `approval.respond` |
| 持久授权被静默授予 | `acceptForSession`、execpolicy/网络修正默认服务端拒绝，需 `CODEX_FLUTTER_ALLOW_PERSISTENT_APPROVALS=1` 显式开启 | `approvals.ts`、`config.ts` |
| 通用 shell 后门 | 全库无通用 shell API；唯一能“跑东西”的路径是 CodexAdapter | `server.ts` 注释、grep 核查 |
| Codex 认证外泄 | companion 不接收、不存储、不转发 `auth.json` / API key；手机只持有配对令牌 | `server.ts`、`config.ts` |
| 进程崩溃后状态不一致 | 崩溃时在途 turn 判 interrupted、未答复审批按已清除处理并发出 `approval.resolved`；重连后用 `thread/loaded/list` 恢复 | `real-adapter.ts` |
| 事件重放/乱序 | 服务端自增全局 `seq`（SQLite 主键，重启不回退）；客户端按 `seq` 幂等去重 + `lastSeq` 补齐；落后窗口回 `snapshot-required` 走 REST 快照 | `modules/events/event-bus.ts`、`app/lib/core/event_store.dart` |
| 版本漂移导致协议错位 | 真实 adapter 启动时 `codex --version` 校验，低于最低版拒绝启动；schema 按目标机 CLI 版本重新生成 | `real-adapter.ts`、`config.ts` |

## 3. 剩余风险（已知，不回避）

1. **协议不加密**：REST + WS 目前是明文 HTTP/WS。只适用于可信 LAN。
   公共 Wi-Fi 下使用等于把令牌与会话内容交给局域网窃听者。
2. **事件广播粒度**：事件目前广播给所有已配对设备，订阅时可按
   session 过滤；多设备细粒度隔离未做。多台手机配对同一 server
   时，一台手机能看到另一台手机的会话事件。
3. **令牌无定期轮换**：令牌长期有效，直到用户手动撤销。建议后续加
   令牌有效期与轮换。
4. **SQLite 令牌哈希无加盐说明**：SHA-256 无盐哈希；令牌本身是
   32 字节随机值，暴力猜测不可行，但哈希库被盗后仍可离线验证猜测值。
   后续可改为加盐哈希或系统凭据存储。
5. **Windows 沙箱行为未验证**：`mxc`/`elevated`/`unelevated` 在目标机
   上的实际表现未知（矩阵 §5），老机器回落后的行为差异要在真机实测。
6. **审批出现时机依赖配置**：默认 `workspace-write` + `on-request`
   下读操作不审；手机长时间收不到审批是正常现象，不是 bug。
7. **`availableDecisions` 字段缺失**：0.164.0-alpha.9 的 schema 里审批
   params 没有该字段（矩阵 §9），adapter 用安全默认值代替；目标机
   新版 CLI 的字段情况仍需核对。
8. **debug APK 未签名 / 未做 release 签名配置**：`flutter build apk
   --debug` 的产物只用于开发验证，不得分发。

## 4. 存储与日志规则

- 敏感值（配对令牌原始值、Codex `auth.json`、API key、完整环境变量、
  工具原始输出）**永不**写入 SQLite、日志文件、手机本地存储、崩溃报告。
- 日志只记事件类型、ID（`deviceId`、`sessionId`、`threadId`、`turnId`）、
  状态码与摘要长度，不记内容。
- `data/`（含 `companion.db`）已进 `.gitignore`，不得提交；备份电脑时
  应加密存放，换电脑时重新配对而不是复制数据库。
- 手机端：令牌只进 Android Keystore；应用卸载即清除。不要把令牌写进
  `shared_preferences`（那里只放非敏感设置）。

## 5. 撤销与恢复

- 单台设备失窃/丢失：在电脑上调 `POST /api/v1/pairing/revoke
  {deviceId}`（设备只能撤销自己；运维可直接删 SQLite 的设备行后重启
  server），或直接删 `data/companion.db` 后重启并重新配对全部设备。
- 配对码泄露：等 5 分钟过期即可（单次使用，过期自动失效）。
- 怀疑令牌泄露：撤销全部设备，重启 server，重新配对。
- server 进程异常退出：重启后事件 `seq` 不回退，客户端按 `lastSeq`
  重连补齐；在途 turn 按 interrupted 处理，需用户在手机上重新发起。

## 6. 公网访问与 TLS（不在 MVP 内，另行设计）

公网访问**不得**直接用裸 LAN token 方案。需要时再单独设计，必须至少
包含：TLS（自签证书 + 证书固定，或受信证书）、端到端加密、设备撤销、
重放防护、令牌短期有效 + 轮换、以及中继服务器的信任模型。二维码配对
也只传地址、不传令牌；令牌仍须经配对码认领流程发放。
