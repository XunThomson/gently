---
status: active
last_verified: 2026-11-01
owner: gently
scope: 安卓端 UI 适配的**基础设施评估**（能不能做、缺什么、按什么顺序做）
token_budget: 1400
tldr: 分层已经适合（core 不依赖 tauri、`crate-type` 已含 cdylib），但**当前机器上 Android 构建还跑不起来**：缺 NDK、缺 rust android target、缺 gradle/AGP 依赖、工程未 `android init`。另有一个真正的产品级问题：现有外壳在手机竖屏（412×915）会被判成 `mini`，整页只剩迷你播放器——移动端必须先有第 4 种形态。本文件只做**评估**；执行计划、P0 逐步命令与验收口径在 [`ANDROID-PLAN.md`](ANDROID-PLAN.md)。2026-11-01 复测新增三条：真机已连（CDY_AN00 · API 29 · arm64）、cargo 缓存已含 android 专用 crate（离线可行）、但 `rquickjs-sys 0.7` **没有 android 的 FFI 绑定**（P0-4 会在此失败）。
---

# 安卓端 UI 适配：基础设施评估

> 结论先行：**可行**，但不是「加个 target 就能跑」。真正的成本不在 Rust（core 已经是平台无关的），
> 而在**外壳形态、触摸语义、后台播放、文件与凭据**这四块。下面每一条都标了「怎么验证」，
> 避免又出现「文档说能跑、实际跑不起来」。

## 1. 结论速览

| 问题 | 结论 | 依据（本机实测） |
|---|---|---|
| core 能否直接编到 Android | **能**（无 tauri 依赖；只有 C 依赖需要 NDK） | `core/src/lib.rs` 无 tauri；`core/Cargo.toml` 里 `windows-sys` 只在 `cfg(windows)` |
| 现在能否 `tauri android build` | **不能** | 见 §2 缺口：NDK、rust target、gradle 依赖、`gen/android` 都缺 |
| 现有前端能否直接跑 | **能渲染，但形态不对** | 手机竖屏会被 `resolveShellMode` 判成 `mini`（§3.1） |
| 最大风险 | 后台播放（Android 8+ 需要前台服务）与后台动画；其次是文件选择（SAF） | 桌面上「失焦暂停背景」的策略在移动端正好相反 |
| 建议下一步 | 先把**工具链**（P0）打通，再动 UI（P1） | 没有 P0 的验收，「适配好了」无法证明。**P0 的逐步命令、期望输出、失败分支与验收证据见 [`ANDROID-PLAN.md`](ANDROID-PLAN.md)**；环境自检用 `pwsh -File scripts/android-env.ps1` |

## 2. 现状盘点与缺口（2026-10-31 首测；2026-11-01 复测的增补见 §2.4）

### 2.1 已经具备的

| 项 | 状态 | 验证方式 |
|---|---|---|
| Tauri CLI 带 android 子命令 | ✅ `tauri-cli 2.11.4`（init / dev / build / run） | `node node_modules/@tauri-apps/cli/tauri.js android --help` |
| `crate-type` 含 mobile 需要的产物 | ✅ `["staticlib","cdylib","rlib"]` | `src-tauri/Cargo.toml` |
| JDK | ✅ 17.0.12（AGP 8 要求 17） | `java -version` |
| Android SDK 平台与 build-tools | ✅ platforms `android-30/34/35`、build-tools `30.0.3/34.0.0/35.0.0` | `F:\Develop\Android\Sdk` |
| 第二份 SDK（含 cmdline-tools） | ✅ `F:\Android\android-sdk`（`cmdline-tools/7.0`、platforms 31/33） | 目录枚举 |
| 模拟器与系统镜像 | ✅ `emulator\emulator.exe`、`system-images\android-35` | 目录枚举 |
| adb | ✅ `F:\Develop\Android\Sdk\platform-tools\adb.exe` | `Test-Path` |

### 2.2 缺口（不补齐就无法构建）

| 缺口 | 为什么必需 | 补齐方式 | 离线可行 |
|---|---|---|---|
| **NDK** | `rusqlite`（bundled SQLite）与 `rquickjs`（`rquickjs-sys` 的 `build.rs` 用 `cc::Build` 编译 `libquickjs.a`）都要**编译 C**；Android 交叉编译必须用 NDK 的 clang | sdkmanager 装 `ndk;26.x` 或 27.x，设 `NDK_HOME` | ❌ 需要联网一次 |
| **rust android targets** | 只为 host 装了 x86_64-pc-windows-msvc；工具链里没有任何 `*-linux-android` 的 std | `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android` | ❌ 需要联网一次 |
| **gradle / AGP 依赖** | `tauri android init` 会生成 gradle 工程，首次构建要拉 Gradle 发行包与 AGP | 首次联网构建一次，之后进 `~/.gradle` 缓存 | ❌ 首次必须联网 |
| **移动工程未初始化** | `src-tauri/gen` 只有 `schemas/`，没有 `android/` | `tauri android init` | ✅（生成本地文件） |
| **AVD** | 没有创建任何虚拟设备（只有系统镜像） | 用 Android Studio 或 `avdmanager` 建一个 | ✅（2026-11-01 决定：**改用真机 USB，不建 AVD**） |

> 也就是说：**P0 阶段需要一次联网 + 装 NDK**。这与此前「离线打包 Windows」的约束不同，
> 建议单独开一次联网窗口做 P0，之后照旧离线开发。

### 2.3 工程形态上必须改的两处（不涉及业务逻辑）

1. `tauri.conf.json` 里的第二扇窗口（`desktop-lyrics`，透明 + 置顶 + 跳过任务栏）在移动端没有对应物；
   移动端只有一个 webview，第二窗配置不会生效。`src/main.tsx` 用 `?window=desktop-lyrics` 区分两条渲染分支，
   移动端只需要主分支。
2. `src-tauri/capabilities/default.json` 用的是 `desktop-schema.json`，并申请了
   `core:window:allow-minimize / toggle-maximize / set-always-on-top …` 这些**桌面才有**的权限。
   移动端应有一份独立的 capability（只留 `core:default` 与必要项），否则会在初始化时被权限校验卡住。

### 2.4 2026-11-01 复测的三条增补（首测没写、且会改变做法）

| 事实 | 影响 |
|---|---|
| **真机已连**：`MKB6R20514007949` · `CDY_AN00` · `arm64-v8a,armeabi-v7a` · **API 29（Android 10）** | 只装 `aarch64-linux-android`；用 API 24 的 NDK clang 编译够；Android 10 意味着 P3 的 SAF 与 P2 的前台服务按「API 26+ / 分区存储」那套规则走 |
| **cargo 缓存已含 android 专用 crate**：1509 个 crate 里有 `jni 0.21/0.22`、`ndk 0.8`、`ndk-sys`、`ndk-context`、`android-activity 0.5`、`tao 0.35`、`wry 0.55` | cargo 侧很可能**不需要新下载**；仍需联网的只有 NDK、rust 的 android std、Gradle/AGP。这削弱了「首次构建必须联网」的结论范围（只对后三样成立） |
| **`rquickjs-sys 0.7` 没有 `aarch64-linux-android` 的 FFI 绑定**（只带 10 个 target；`src/lib.rs` 在不开 `bindgen` 时 `include!("bindings/<target>.rs")`，`build.rs` 只给一条 warning） | `cargo build --target aarch64-linux-android` 会**直接编译失败**。三条路（复制绑定 patch / 开 bindgen / 升级 rquickjs）见 [`ANDROID-PLAN.md`](ANDROID-PLAN.md) §3.1，需要先拍板 |

> 网络测法的边界要说清：本会话的**子进程 HTTPS 全部失败**（`curl` 报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`），
> 所以「逐个端点的 HTTP 码」这次**没能判定**；已确认的只有 TCP 层可达与
> `dl.google.com/dl/android/maven2` 的 200（走 `web_fetch`）。逐端点的复测请在普通终端里跑 `scripts/android-env.ps1`。
> 另一条：`maven.google.com` TCP 不通，但它只是网页索引，Gradle 的 `google()` 用的是 `dl.google.com/dl/android/maven2`。

## 3. 前端：哪些地方是「桌面专属」的（按文件列出）

### 3.1 外壳形态（**最关键**）

`src/utils/shellMode.ts::resolveShellMode` 的规则是：`宽 < 720 或 高 < 480 → mini`。
手机竖屏（412×915 CSS px）**直接落进 mini**，整个应用只剩迷你播放器（`App.tsx` 的 mini 分支不渲染路由与侧栏）。
所以移动端第一步不是「调样式」，而是**新增第 4 种形态 `mobile`**：

- 判定输入要区分「平台」而不仅是尺寸（`data-platform="android"` 或 `useShellMode` 接受一个 `platform` 参数）；
- `mobile` 形态：底部 tab 导航（替换 232px 侧栏）+ 单栏内容 + 底部迷你播放条；
- 现有 `compact`（图标栏）可保留给平板横屏。

### 3.2 窗口能力

| 位置 | 现状 | 移动端处理 |
|---|---|---|
| `components/shell/title-bar/**` | 最小化 / 最大化 / 关闭 / `data-tauri-drag-region` 拖动 | 移动端不渲染窗口按钮；标题栏退化为页面标题 |
| `services/window.service.ts` | `minimize / toggleMaximize / alwaysOnTop / pip / 桌面歌词窗口位置` | 全部 no-op 或按平台分支；PIP 换成系统画中画 |
| `hooks/useShellMode` + `config/app.config.ts` 的 `window.breakpoints` | 按窗口尺寸裁决形态 | 增加 `platform` 维度（见 §3.1） |
| `widgets/desktop-lyrics/**` + `hooks/useDesktopLyricsBridge.ts` | 第二个透明置顶窗口显示歌词 | 移动端改**通知栏歌词 / 悬浮窗**（需要前台服务与悬浮窗权限） |

### 3.3 触摸语义（hover 在触屏上不存在）

- `components/shell/player-bar/SeekBar`：悬浮/拖拽才显示焦点 → 触屏需要常显可拖拽手柄；
- 发现页（`views/hot/components/DiscoverPanel.tsx`）：「划过即试听」在触屏上等于「点一下」，
  需要区分 tap（选中）与再次 tap（播放）；
- 所有 `:hover` 反馈（行高亮、播放条 chip）在移动端要退化为 `:active`。

### 3.4 布局宽度

业务列表是 7 列（`config/table.config.tsx` 的列宽下限合计 598），另有 232px 侧栏；
手机可用宽度约 360–430。移动端不能用同一套 `grid` 列定义，需要「列表 → 单栏卡片/两行」的呈现
（可以在 `table.config.tsx` 旁增加一份 `mobileColumns`／或引入 `useViewport` 决定用哪一份，
但**不要在视图里散落 `@media`**）。

### 3.5 文件与存储

| 能力 | 桌面实现 | 移动端现实 |
|---|---|---|
| 插件/皮肤导入 | 粘贴路径（核心读文件）、`<input type=file>` | Android 没有可随意读的绝对路径；要用 SAF（`content://` URI）→ 需要宿主提供读 URI 的能力 |
| 「在文件夹中显示」 | `fileService.revealInDir`（explorer） | 无对应物；改成「分享/用其他应用打开」或直接隐藏 |
| 数据目录 | `resolve_data_paths`（环境变量 > 指针 > 便携版 > 系统默认） | 应用私有目录即可；**便携版与指针文件逻辑在移动端无意义**（只保留环境变量覆盖用于调试） |
| 下载目录 | 用户填绝对路径 | 走 SAF 树 URI 或应用私有目录 + 导出 |

### 3.6 凭据

`plugin/keyring.rs` 的 Windows 分支不参与编译，落回进程内存储 → `system.status.credentialsBackend` 会如实报 `memory`，
界面已经会提示「重启后要重填」。**Keystore 接入是独立里程碑**，不要和 UI 适配混在一起。

### 3.7 媒体与后台

- 回环媒体代理（`core/src/media.rs`）在 Android 上仍然可用，但需要 `INTERNET` 权限（Tauri 模板默认加）；
- 后台继续出声要**前台服务 + MediaSession**（Android 8+），Tauri 默认不提供 → 需要自写插件或
  使用社区插件（引入新依赖要先评估：本机离线缓存里没有的东西不能想当然）；
- 后台时**不能**沿用「窗口隐藏就暂停背景视频/动画」的策略（桌面上是对的，移动端会把播放一起掐掉）。

## 4. 分阶段计划 → 只在执行计划里维护

阶段划分（P0 工具链 → P1 移动外壳 → P2 后台播放 → P3 导入与存储 → P4 桌面歌词替代）、
每阶段的**入口条件、逐步命令、验收证据**一律写在 [`ANDROID-PLAN.md`](ANDROID-PLAN.md)
（§4 = P0 逐步命令，§7 = P1–P4），本文件不再维护第二份，避免两边漂移。

2026-11-01 的决定：**先只做 P0**；P1 是否立即跟进等 P0 的证据。
P2 之前先做一次实测（锁屏 5 分钟 WebView `<audio>` 是否还活着）再定实现形态，
不先选「WebView + 保活」还是「原生 Media3」。

## 5. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 离线构建断裂 | Android 首次构建必然要联网（NDK / rust std / gradle），与桌面「离线可用」的约定冲突 | P0 单独开联网窗口；把「联网一次、之后离线」写进 P0 的验收记录 |
| C 依赖交叉编译失败 | `rusqlite` bundled / `rquickjs` 在全链路上都要 C 编译器 | 先在 P0 用最小 crate 验证 `cc` + NDK 工具链，再编 core |
| WebView 音频策略 | 移动端自动播放限制更严；后台会被冻结 | 播放始终由用户手势触发（现有设计已是）；后台用 P2 的前台服务 |
| 性能 | 背景视频 + backdrop-filter 在移动 GPU 上很贵 | 移动端默认关闭背景视频与内容虚化（沿用设置项，不新增开关），或按设备能力降级 |
| 触摸误触 | 播放条操作密集、行内动作多 | 移动端把行内动作收进「行点击 → 底部操作面板」 |
| 平台 API 差异未实测 | `app.windows` / capability 在移动端的实际行为需要跑一次才知道 | 列为 P0 的「实测清单」，结论回写本文件 |

## 6. 本轮不做

- 不新增任何依赖、不改桌面行为、不改契约；
- 不改 `resolveShellMode` 的现有三档（移动端形态等 P1 一起做，避免先改出半成品）；
- 不在移动端复刻桌面歌词窗口与宠物渲染（各自等 P4 / pet-core ADR）。

## 7. 相关文档

- **执行计划与 P0 逐步命令**：[`ANDROID-PLAN.md`](ANDROID-PLAN.md)（阶段、命令、期望输出、风险、执行记录）
- 环境自检（只读）：`scripts/android-env.ps1`
- 可复用的设计清单：[`DESIGN-REUSE.md`](DESIGN-REUSE.md)（§2 core 分层、§4 播放链路、§7 桌面专属项）
- 本机核心契约：[`contracts/local-core-api.md`](contracts/local-core-api.md)
- 宠物扩展（移动端是否共用同一渲染器见 ADR 0010 未决项）：[`adr/0010-pet-core-crate.md`](adr/0010-pet-core-crate.md)
