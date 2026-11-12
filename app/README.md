# Codex Flutter — Android 客户端（Phase 3，Flutter MVP）

Flutter/Dart 客户端，通过 companion server（`../server/`）在手机上查看和操作
自己电脑上的 Codex。协议见 `../docs/protocol.md`（v1.0.0），实现细节见
`../docs/codex-capability-matrix.md`。

> **验证状态（2026-11-12，本机实测）**：Flutter 3.50.0（官方 Linux 稳定版，
> 修订版 ab2912035e）已装到本机 `~/flutter-sdk/flutter`（不在仓库内），
> `dart analyze` **零问题**，`flutter test` **35/35 通过**
> （协议解析、事件去重、审批逻辑、审批卡片 widget 测试各 4 套）。
> 依赖版本见 `pubspec.yaml`（http 1.2、web_socket_channel 3.0、
> flutter_secure_storage 9.2、shared_preferences 2.2、uuid 4.0、
> mobile_scanner 6.0、material_ui 1.11）；`pubspec.lock` 已删除——
> 本机 `dart pub get` 走临时本地镜像代理生成，锁文件绑定了
> `http://127.0.0.1:19090`，在别的机器上无法解析依赖，在网络正常
> 的机器上直接 `flutter pub get` 重新生成，不要把旧锁文件加回来。
> 未验证的只有：debug APK 构建（本机无 Android SDK，见下方）与 Android
> 真机配对/重连/审批端到端（Phase 4，见 `../docs/e2e-verification.md`）。

## 如何跑

```sh
cd app
flutter pub get                 # 需能直连 pub.dev（或官方镜像）；见下注
flutter run                 # 接 Android 真机/模拟器，debug 运行
flutter analyze             # 静态分析
flutter test                # 单元测试 + widget 测试
flutter build apk --debug   # debug APK
flutter build apk --release # release APK（发布前再做签名配置）
```

要求：Flutter 3.22+ / Dart 3.4+（`pubspec.yaml` 的 `environment` 约束）。
注：本仓库没有 `pubspec.lock`（原因见“已知限制”）；在网络正常的
机器上先 `flutter pub get` 生成锁文件再跑上面命令。在本机沙箱里
Dart 的 TLS 挂死、`pub get` 会挂起，改用 `flutter test --no-pub`
（跳过依赖解析，直接用已有的 `.dart_tool/package_config.json`）。

## 结构

```text
lib/
  main.dart                        # 入口：已配对进项目列表，未配对进配对页
  core/
    protocol_models.dart           # 协议 v1.0.0 模型：13 种事件、5 种命令、审批决定
    rest_client.dart               # REST：配对认领、项目/会话列表、历史快照、撤销设备
    ws_client.dart                 # WebSocket：订阅/重连/命令（requestId）/快照回退
    event_store.dart               # 按 seq 幂等去重 + lastSeq 水位
    token_store.dart               # 令牌存 Android Keystore（flutter_secure_storage）
    settings_store.dart            # 非敏感设置：服务器地址、自动重连、lastSeq
    app_state.dart                 # 应用级连接状态
  features/
    pairing/                       # 配对页（输入/扫码地址 + 配对码）与扫码页
    projects/                      # 项目列表
    sessions/                      # 会话列表 + 新建会话
    chat/                          # 聊天流（REST 历史 + WS 实时事件）与运行状态
    approvals/                     # 审批卡片（availableDecisions 驱动）与纯函数规则
    settings/                      # 连接设置（地址、重连、撤销设备、服务端版本）
test/
  protocol_test.dart               # 协议解析：13 种事件、5 种命令、审批 payload、fixtures
  event_store_test.dart            # 事件去重 / 乱序 / 水位恢复
  approval_logic_test.dart         # availableDecisions 驱动与过期/断连不可点
  approval_card_test.dart          # widget 测试：按钮渲染、持久授权置灰、过期不可点
```

## 与 companion server 的配对流程

1. 在电脑上启动 companion server（见 `../server/README.md`）：
   `cd server && npm run build && npm start`，默认 `127.0.0.1:5291`；
   暴露到局域网需显式配置 `CODEX_FLUTTER_HOST` 为私有 LAN 地址。
2. 在电脑本机生成一次性配对码（只能 loopback）：
   `POST /api/v1/pairing/code`，得到 6 位数字码（5 分钟有效），
   连同服务器局域网地址一起显示在电脑屏幕上。
3. 在手机 App 的配对页输入（或扫码）服务器地址 `host:port`、6 位配对码
   与设备名称，点「配对」。App 调 `POST /api/v1/pairing/claim`，拿到
   `{deviceId, token}` 后立即存入 Android Keystore，不在界面、日志或
   剪贴板中出现。
4. 配对成功后进入项目列表。聊天时 App 先用
   `GET /api/v1/sessions/:id/history` 拉历史快照，再连
   `ws://host:port/ws?token=…` 订阅实时事件（`lastSeq` 续传）。

## 通信分工

- **REST**：配对认领、项目/会话列表、历史快照、撤销设备。
- **WebSocket**：实时事件与全部 5 种命令
  （`session.create` / `session.resume` / `message.send` /
  `session.cancel` / `approval.respond`）。每个有副作用的命令带唯一
  `requestId`（uuid v4），服务端对重复 `requestId` 直接回放已存结果。
- 断线后按退避间隔自动重连（可在设置中关闭），重连时带最新 `lastSeq`
  订阅，服务端补发错过的事件；客户端按 `seq` 幂等去重。
  若服务端回 `snapshot-required`，App 改走 REST 拉历史快照。

## 审批卡片规则（Issue #1 强制约束）

- 只按每条 `approval.requested` 自带的 `availableDecisions` 渲染按钮，
  绝不写死 accept/decline。
- `acceptForSession` / `acceptWithExecpolicyAmendment` /
  `applyNetworkPolicyAmendment` 是持久授权，服务端默认拒绝；出现在请求
  里时也只渲染为置灰按钮并注明「需服务端开启」。
- 请求一旦被答复、过期（默认 15 分钟）、取消、所属 turn 结束或客户端
  断连，即显示「已失效」，按钮不可点；权威状态以服务端随后发来的
  `approval.resolved` 为准。
- `networkApprovalContext` 出现时是「管制网络访问」审批，单独渲染
  host/protocol，不当普通命令展示。

## 运行状态

聊天页顶栏显示：生成中 / 等待审批 / 完成 / 失败 / 已断连。
断连时历史仍可查看，横幅提示重连后自动补齐；重连成功后按 `lastSeq` 补发。

## 已知限制

- **未构建 debug APK**：本机无 Android SDK，
  `flutter build apk --debug` 在第一步即报
  `No Android SDK found. Try setting the ANDROID_HOME environment variable.`。
  Android 工程骨架已生成（`android/`，applicationId
  `com.codexflutter.codex_flutter`，INTERNET/CAMERA 权限，
  `usesCleartextTraffic=true`——Phase 1 局域网明文协议所必需，见下）；
  有 Android SDK 的机器上直接跑 `flutter build apk --debug` 即可验证。
  插件的真机平台通道注册（flutter_secure_storage / mobile_scanner /
  shared_preferences）也只有完整构建才能验证。
- **需 Android 真机验证**：配对全流程、WebSocket 断线重连、审批卡片
  的端到端表现、Keystore 存储，均未在真机上验证过。
- **无 TLS**：Phase 1 协议不加密，只做可信局域网配对；不要把 server
  暴露到公网。TLS/二维码配对（二维码目前只传地址，不传令牌）在 Phase 4 评估。
- **真实 adapter 已有，真实 turn 未验证**：server 默认仍是 mock
  adapter，但 Phase 2 已实现真实 adapter（`CODEX_FLUTTER_CODEX_MODE=real`，
  stdio 拉 `codex app-server`），只经过本地 fake app-server stub
  验证（`npm test` 28/28）；登录后真实 turn 与真实审批的端到端
  验证仍是目标机门槛，见 `../docs/e2e-verification.md` §2。
- **Flutter 3.50 的 Material 库迁移**：上游把 Material 组件库从 SDK
  移到了官方包 `material_ui`（1.11.0），`package:flutter/material.dart`
  已废弃。本项目已迁移到 `package:material_ui/material_ui.dart`，
  `dart analyze` 零问题、`flutter test` 全部通过。
- **本机装 Flutter 的过程记录**（后面在同类沙箱里重做时可复用）：
  本机 `/tmp` 只是 512MB tmpfs，1.5GB 的 SDK tarball 必须下载到磁盘
  充足的目录（如 `~/flutter-sdk/`），且要用
  https://storage.flutter-io.cn 镜像（约 2MB/s；Google 官方源在
  本机只有约 70KB/s）。校验时注意 releases 索引里 `hash` 字段是 git
  修订版，真正的 SHA-256 在 `sha256` 字段。解压要用
  `tar --no-same-owner`（否则 chown 失败）。本机 Dart 的 TLS 握手
  在沙箱出口代理后挂死（curl/Python 正常），`dart pub get` 须经
  本地明文代理（`/tmp/pub_mirror_proxy.py`，只转发到
  pub.flutter-io.cn，pub 按上游元数据里的 SHA-256 校验包完整性）；
  该代理只是本机装依赖的临时工具，未进仓库，下次重新解析依赖时
  仍需它或一台网络正常的机器。
- **不做的事**：不上传源码/会话内容/密钥；不直连 Codex CLI/SDK；
  不把 Claude 的 SDK 或会话协议当成 Codex 接口；事件名与命令名只用
  协议 v1.0.0 里真实的 13 种事件与 5 种命令。
