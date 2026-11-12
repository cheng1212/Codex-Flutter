# 安装与启动说明（Windows 目标机 + Android）

> 状态（2026-11-12）：**Windows 部分的步骤尚未在真机上跑过**。
> Phase 0 的 Windows 信息来自第三方指南对官方文档的转述，本次未直
> 接打开官方 Windows 安装页核对（矩阵 §5 第 1 条）；照着做时若发现
> 步骤与官方当前文档不符，以官方文档为准，并把差异记回矩阵。
> Android 部分的命令是标准 Flutter 命令，未在本机跑通（无 Android
> SDK，见 §3），有 SDK 的机器可直接验证。

## 1. Windows 目标机：装 Codex CLI

前置：Windows 11 为推荐基线；Windows 10 1809+ 为 best effort 支持。
原生 PowerShell 安装（官方安装器，二手转述，需在真机上核对）：

```powershell
irm https://chatgpt.com/codex/install.ps1 | iex
```

装完核对版本（companion 要求 ≥ `0.166.0`，低于此版真实 adapter
拒绝启动；本机验证用的是 `0.164.0-alpha.9`，低于最低版）：

```powershell
codex --version
```

登录 Codex（在电脑上做，**不要**把凭证交给手机或 companion）：

```powershell
codex login
```

或配好 `CODEX_API_KEY` 环境变量。凭证存放在
`%USERPROFILE%\.codex\auth.json`，companion 绝不读取它。
装完后先在 PowerShell 里跑一次原生探针，确认 app-server 能起来：

```powershell
codex app-server --help
```

沙箱：Windows 原生沙箱默认开启；`mxc` 需要特定 Win11 build，老
机器会回落到 `elevated`/`unelevated`，行为差异要在目标机实测
（矩阵 §5）。WSL2 只在需要 Linux 工具链时选用；WSL1 自 0.115 起
不再支持。

## 2. Windows 目标机：跑 companion server

前置：Node.js 20+（建议用官方 LTS；本机验证用 Node v24.22.1）。

```powershell
git clone https://github.com/cheng1212/Codex-Flutter.git
cd Codex-Flutter\server
npm install   # 只有开发依赖（typescript、@types/node、ajv）
npm run build
npm test      # 28 项测试：13 项契约 + 15 项真实 adapter（fake app-server stub）
npm start     # 默认只绑 127.0.0.1:5291
```

服务起来后先看健康检查（无须认证）：

```powershell
curl http://127.0.0.1:5291/healthz
```

期望返回 `{"status":"ok","protocolVersion":"1.0.0","codex":{"mode":"mock",...}}`
（默认 mock）。切真实 Codex：

```powershell
$env:CODEX_FLUTTER_CODEX_MODE = "real"
npm start
```

此时 healthz 应返回 `codex: {"mode":"real","version":"0.166.x","connected":true}`。
若版本低于最低版或找不到 `codex` 二进制，server 明确报错拒绝启动，
**不**静默回落到 mock。

局域网暴露（手机要连时才做）：把 `CODEX_FLUTTER_HOST` 设为电脑的
私有 LAN 地址（例如 `192.168.1.10`），不要用 `0.0.0.0`；每次请求
仍要配对令牌；不要开路由器端口、不要暴露到公网。

```powershell
$env:CODEX_FLUTTER_HOST = "192.168.1.10"
$env:CODEX_FLUTTER_WORKSPACES = "default=C:\Users\<你>\Work"
npm start
```

配对码（只能在电脑本机上生成，loopback 限定）：

```powershell
curl -X POST http://127.0.0.1:5291/api/v1/pairing/code
```

得到 6 位码（5 分钟有效）后，连同服务器 LAN 地址一起告诉手机。
配对、撤销与环境变量全表见 `server/README.md`。

## 3. Android：装 Flutter 与 Android SDK，构建 debug APK

前置：Flutter 3.22+ / Dart 3.4+（本项目在 Flutter 3.50.0、
Dart（随 SDK）上验证过 `dart analyze` 零问题、`flutter test` 35/35；
注意 Flutter 3.50 起 Material 库在官方包 `material_ui` 里，不再是
`package:flutter/material.dart`，本项目已迁移）。

```sh
# 1. 装 Flutter（Linux 示例；Windows 用官方 zip，解压到无空格路径）
git clone https://github.com/flutter/flutter.git -b stable --depth 1 ~/flutter
export PATH="$HOME/flutter/bin:$PATH"

# 2. 装 Android SDK：装 Android Studio，或只装 cmdline-tools
#    然后接受许可：
flutter doctor --android-licenses

# 3. 构建
cd Codex-Flutter/app
flutter pub get          # 需能直连 pub.dev（或官方镜像）；见下注
flutter analyze          # 应为 No issues found
flutter test             # 应为 35/35 通过
flutter build apk --debug
```

产物在 `app/build/app/outputs/flutter-apk/app-debug.apk`，装到手机
上即可。release 构建（`flutter build apk --release`）发布前须先配
正式签名，本仓库不含任何 keystore，debug 产物不得分发。

> 注（本机实测，2026-11-12）：本机云主机上 `dart pub get` 曾因 Dart
> 的 TLS 在沙箱出口代理后挂死而走本地明文代理镜像，生成的
> `pubspec.lock` 因此绑定了临时地址 `http://127.0.0.1:19090`——
> 该文件已从仓库删除，**不要把它加回来**。在网络正常的机器上直接
> `flutter pub get` 会重新生成锁文件（依赖版本见 `pubspec.yaml`：
> http 1.2、web_socket_channel 3.0、flutter_secure_storage 9.2、
> shared_preferences 2.2、uuid 4.0、mobile_scanner 6.0、
> material_ui 1.11）。若 `flutter build apk --debug` 报
> `No Android SDK found`，先设 `ANDROID_HOME` / `ANDROID_SDK_ROOT`
> 指向 SDK 目录再重试。

## 4. 手机配对与使用

1. 电脑上按 §2 启动 server 并生成 6 位配对码。
2. 手机 App 打开即进配对页：输入（或扫码）服务器地址 `host:port`、
   6 位配对码与设备名称，点「配对」。App 调
   `POST /api/v1/pairing/claim`，拿到令牌后立即存入 Android
   Keystore，不在界面、日志或剪贴板中出现。
3. 配对成功后进入项目列表 → 会话列表 → 聊天。发送消息、查看流式
   输出；出现审批卡片时按卡片上的按钮批准或拒绝（只按请求自带的
   `availableDecisions` 渲染，过期/已失效的卡片不可点）。
4. 断网后 App 自动重连并按 `lastSeq` 补齐事件；若提示快照回退，
   会自动走 REST 拉历史。

完整验证清单与结果见 `docs/e2e-verification.md`，威胁模型见
`docs/threat-model.md`。
