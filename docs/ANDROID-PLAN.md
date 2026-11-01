---
status: draft
last_verified: 2026-11-01
owner: gently
scope: 安卓端**执行计划**：P0（工具链跑通）的逐步命令、期望输出、失败分支与验收证据；P1–P4 的范围与顺序
token_budget: 1900
tldr: 用户 2026-11-01 决定重启安卓：**同一仓库 + `src-tauri/gen/android`**、**真机 USB**（不要模拟器）、本轮只做 **P0**、命令由用户手动执行。当日复测出三件评估文档没写的事：① 本机 cargo 缓存（1509 crate）已含 android 专用 crate（jni 0.21/0.22、ndk 0.8、ndk-sys、ndk-context、android-activity 0.5、tao、wry）→ cargo 侧很可能全程离线；② **`rquickjs-sys 0.7` 没有 `aarch64-linux-android` 的 FFI 绑定**，不开 `bindgen` 就编不过（三条路待拍板，见 §3.1）；③ `maven.google.com` 不通，但 Gradle 的 `google()` 走 `dl.google.com/dl/android/maven2`（实测 200），大概率不阻塞。P0 验收**不看界面**（真机 412×915 会被 `resolveShellMode` 判成 mini），看真机日志里核心自己打的三行。
---

# ANDROID-PLAN：安卓端筹备与 P0–P4

> 结论先行：安卓**可行**，但本轮的目标不是「适配 UI」，而是**先把工具链钉死**。
> 现状评估见 [`ANDROID-INFRA-ASSESSMENT.md`](ANDROID-INFRA-ASSESSMENT.md)（缺什么、为什么）；
> 本文件只写「按什么顺序做、每条命令的期望输出、怎么才算验收、失败找谁」。

## 0. 已拍板的四件事（2026-11-01，用户决定）

| 维度 | 决定 | 含义 |
|---|---|---|
| 工程形态 | **同一仓库**，Tauri 标准移动路径 `src-tauri/gen/android` | 复用同一份 `core`、同一份 React 前端、同一套契约守卫；不新建工程、不复制契约 |
| 本轮范围 | **只做 P0（工具链跑通）** | P1 外壳 / P2 后台播放 / P4 通知栏歌词都不在本轮 |
| 验收设备 | **真机 + USB 调试**（不建 AVD） | 只装 `aarch64-linux-android`（不装 x86_64 / armv7） |
| 执行方式 | **我出命令与验收口径，你手动执行** | 命令涉及工作区外目录（`F:\Develop\Android\Sdk`、`F:\Develop\Rust\.rustup`、`~/.gradle`）与联网下载，不由我代跑 |

## 1. P0 的验收定义（三条硬标准，缺一不算）

1. `cargo build --target aarch64-linux-android -p gently-core` 通过 —— 证明 `rusqlite`(bundled SQLite)、`rquickjs`(QuickJS C)、`ring`(rustls 汇编) 三条 C/asm 依赖都能过 NDK 交叉编译；
2. `src-tauri/gen/android` 生成，`pnpm tauri android dev` 把 APK 装到真机并**启动**（界面是迷你播放器，这是预期，见 §3.3）；
3. 真机上能读到核心自己写的日志，且**三行都在**：

   ```
   数据目录：…（来源 …）
   数据库就绪 db=… version=8
   宠物核心就绪 dir=…
   ```

   取法（dev 包是 debuggable，`run-as` 可读）：

   ```powershell
   & 'F:\Develop\Android\Sdk\platform-tools\adb.exe' shell run-as com.xun.gently ls files/logs
   & 'F:\Develop\Android\Sdk\platform-tools\adb.exe' shell run-as com.xun.gently cat files/logs/gently.log.<日期>
   ```

   > 为什么用日志而不是「打开设置页看诊断卡」：真机宽度约 412 CSS px，`resolveShellMode` 会判成 **mini**，
   > 而 `App.tsx` 的 mini 分支不渲染路由与侧栏，**设置页根本进不去**。这也是 P1 必须先做的原因。

**P0 明确不证明的事**（不要在这些上给「通过」）：
插件沙箱（QuickJS）**没有在真机上跑过** —— 沙箱只在用户动作 `catalog.search` 之后 `ensure_loaded` 才建运行时，
所以 FFI 绑定是否 ABI 正确，要等 P1 有设置页之后导一个 demo 插件才知道。

## 2. 当日复测的环境事实（2026-11-01，本机实测）

| 项 | 状态 | 依据 |
|---|---|---|
| rustc / cargo | ✅ 1.97.1 | `rustc -V` |
| rust android targets | ❌ 只有 `x86_64-pc-windows-msvc` | `rustup target list --installed` |
| JDK | ✅ 17.0.12，`JAVA_HOME` 已设 | `java -version` |
| Android SDK（主） | ✅ `F:\Develop\Android\Sdk`：platforms `android-30/34/35`、build-tools `30.0.3/34.0.0/35.0.0`、`platform-tools`(adb)、`emulator` | 目录枚举 |
| `cmdline-tools`（sdkmanager 7.0） | ⚠️ 只在**另一个** SDK：`F:\Android\android-sdk` | 装包时要用 `--sdk_root` 指回主 SDK |
| NDK | ❌ 两个 SDK 目录都没有 `ndk/` | 目录枚举 |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` / `NDK_HOME` | ❌ 全为空 | 环境变量 |
| `~/.gradle` | ❌ 不存在（无 Gradle 发行包 / AGP 缓存） | 目录枚举 |
| `src-tauri/gen` | ⚠️ 只有 `schemas/`，没有 `android/` | 目录枚举 |
| 连接的真机 | ✅ `MKB6R20514007949` · `CDY_AN00` · abilist `arm64-v8a,armeabi-v7a` · **API 29（Android 10）** | `adb devices -l` + `getprop`（2026-11-01 17:26） |
| 联网（构建期端点） | ⚠️ **未判定**：TCP 层可达（`index.crates.io` / `static.rust-lang.org` / `services.gradle.org` / `repo.maven.apache.org` / `dl.google.com`），`dl.google.com/dl/android/maven2` 的 HTTPS 取到了 **200**；但**本会话的所有子进程 HTTPS 都失败**（`curl` 报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，受限会话拿不到 TLS 凭据），所以逐端点的 HTTP 码**必须在你的终端里复测一次**（`scripts/android-env.ps1` 会把它们标成 WAIT 而不是 MISS） | TCP 探测 + `web_fetch` 200 + curl 错误码 |
| `maven.google.com` | ❌ TCP 不通，但**不影响构建**：它只是网页索引，Gradle 的 `google()` 用的是 `dl.google.com/dl/android/maven2` | 见 §5 风险 1 |
| cargo 缓存 | ✅ 1509 个 crate，**已含 android 专用 crate**：`jni 0.21/0.22`、`ndk 0.8`、`ndk-sys 0.5`、`ndk-context`、`android-activity 0.5.2`、`tao 0.35`、`wry 0.55` | registry 缓存枚举 |
| 宿主已具备移动端入口 | ✅ `src-tauri/Cargo.toml` 的 `crate-type` 含 `staticlib`/`cdylib`；`lib.rs` 已有 `#[cfg_attr(mobile, tauri::mobile_entry_point)]` | 源码 |
| Tauri CLI | ✅ `tauri-cli 2.11.4`，`android init/dev/build/run` 均在 | `tauri android --help` |

> 一句话：**只差 NDK + rust target + Gradle 缓存 + `android init`**；cargo 侧大概率不需要新下载。

## 3. 三个必须先解决/先知道的技术事实

### 3.1 QuickJS 没有 Android 的 FFI 绑定（会直接编译失败）—— 需要你拍板

证据（读了本机缓存里的 crate 源码，不是推测）：

- `rquickjs-sys 0.7.0/src/lib.rs`：**没开 `bindgen` feature** 时执行
  `include!(concat!("bindings/", bindings_env!("TARGET"), ".rs"))`；
- 该 crate 只带了 10 个 target 的绑定文件（`aarch64-unknown-linux-gnu`、`x86_64-pc-windows-msvc` 等），
  **没有 `aarch64-linux-android`**；`build.rs` 只会打一条 `cargo:warning`，随后编译在 `include!` 处失败。

三条路（成本与风险都是实测/查过的，不是估的）：

| 方案 | 做法 | 代价 | 风险 |
|---|---|---|---|
| **B. vendored patch（我建议）** | 把 `rquickjs-sys 0.7.0` 复制进 `vendor/`，补一份 `src/bindings/aarch64-linux-android.rs`（内容取 `aarch64-unknown-linux-gnu.rs`，两者都是 LP64、C ABI 同构），`[patch.crates-io]` 指过去 | 仓库多 **4.83 MB**（其中 quickjs C 源码 3.87 MB）、多一份上游代码需注明版本与改动（MIT） | 绑定内容正确性只能靠真机跑一次沙箱来证明（P1 才有入口） |
| A. 开 `bindgen` feature（仅 android target） | `core/Cargo.toml` 加 `[target.'cfg(target_os="android")'.dependencies] rquickjs-sys = { workspace = true, features = ["bindgen"] }` | 要**联网**拉 `bindgen`+`clang-sys`（本机缓存里没有）；要一个 `libclang`（本机没 LLVM/VS，**NDK 是否自带 `libclang.dll` 尚待装完才知道**） | 三条路里最不稳：多一条代码生成链，跨平台生成还常出类型偏差 |
| C. 升级 `rquickjs` | 换到带 android 绑定的新版本 | 要联网 + 可能要改 `Ctx` 等 API | 最大，且和「不引入不必要改动」冲突 |

> **已定：B（2026-11-01 用户拍板），当天落地。** 落地内容与验证状态：
>
> | 项 | 内容 |
> |---|---|
> | 新增 | `vendor/rquickjs-sys/`：上游 0.7.0 的逐文件副本（137 文件 / 4.83 MB），**唯一改动**是新增 `src/bindings/aarch64-linux-android.rs`（取 `aarch64-unknown-linux-gnu.rs`，LP64 同 ABI）；来路/许可/撤销方式写在 `vendor/rquickjs-sys/VENDORED.md` |
> | 接线 | 根 `Cargo.toml`：`[workspace] exclude = ["vendor"]` + `[patch.crates-io] rquickjs-sys = { path = "vendor/rquickjs-sys" }`（版本不变，没升级依赖） |
> | ✅ 已验 | `cargo test -p gently-core --offline`：构建日志出现 `Compiling rquickjs-sys v0.7.0 (…\vendor\rquickjs-sys)`，**全部测试通过**（82 单元 + 全部集成套件，含插件沙箱的 `infinite_loop_is_interrupted_by_timeout` 等）→ patch 生效且**桌面端行为未变** |
> | ❌ 未验 | Android 目标下的**编译**（要等 P0-3/P0-4 装好 NDK+target）与**运行**（P0-8 真机跑插件沙箱）。在那之前这份绑定属于「结构正确、未运行验证」 |
>
> 另两条路（A 开 `bindgen` / C 升级 `rquickjs`）作为备选保留在下面，若 P0-4 仍失败再回头评估。

### 3.2 移动端 capability 与多窗口配置：**先跑，报错再改**（不预先动手）

- `src-tauri/capabilities/default.json` 绑 `desktop-schema.json`，并申请了 `core:window:allow-minimize` /
  `toggle-maximize` / `set-always-on-top` / `set-ignore-cursor-events` 等**桌面才有**的权限；
- `tauri.conf.json` 有**三个**窗口（`main` / `desktop-lyrics` / `pet`），移动端只有一个 webview。

可能在哪里炸：`tauri android init` 或首次 build 的 ACL 校验，或启动后 `listen/emit` 被静默全拒（GOTCHAS 里有同类坑）。
对策按需（不要提前改，避免改出个「桌面端也变了」）：
- 平台专属配置合并可用 `src-tauri/tauri.android.conf.json`（CLI 会自动合并）；
- capability 支持 `platforms` 字段，可拆出 `mobile.json`（只留 `core:default` 与必要项）。
真正遇到的错误签名请原样贴回 §6，**别只贴结论**。

### 3.3 真机上一定是迷你播放器（P0 的预期现象）

`src/utils/shellMode.ts`：`宽 < 720 或 高 < 480 → mini`；手机竖屏 412×915 直接落进 mini。
所以 P0 起来的界面**就是迷你播放器**（封面/标题/控制/进度），不是 bug，也不是「跑通了 UI」。
第 4 种形态 `mobile` 属于 P1。

## 4. P0 任务清单（逐步；每条都写期望输出与失败分支）

> 约定：以下命令都在仓库根目录 `F:\Program Files\XunTools\gently` 的 pwsh 里跑；
> 环境变量先用**会话级**（关掉窗口就没了），等 P0 绿了再决定要不要 `setx` 持久化。
>
> **每做完一步先跑一次自检**，它会把缺的东西按顺序列出来（只读，不装任何东西）：
>
> ```powershell
> pwsh -File scripts/android-env.ps1            # 全量（含网络探测）
> pwsh -File scripts/android-env.ps1 -NoNetwork  # 只在没有网络时看本地事实
> ```

### P0-0 插真机、认设备 —— ✅ 已达成（2026-11-01 17:26）

```powershell
& 'F:\Develop\Android\Sdk\platform-tools\adb.exe' devices
```

期望：一行 `<序列号>	device`。
**当前状态**：`MKB6R20514007949` · `CDY_AN00` · `arm64-v8a,armeabi-v7a` · **API 29（Android 10）**。
失败分支（换设备/换线时会用到）：`unauthorized` → 手机上点「允许 USB 调试」；无任何行 → 换数据线 / 打开「USB 调试（安全设置）」/ 装厂商 USB 驱动。

### P0-1 环境变量（会话级）

```powershell
$env:ANDROID_HOME = 'F:\Develop\Android\Sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$env:ANDROID_HOME\platform-tools;$env:PATH"
# NDK 在 P0-2 装完后再设：
# $env:NDK_HOME = "$env:ANDROID_HOME\ndk\<版本>"
```

期望：`Get-Command adb` 能找到。

### P0-2 装 NDK（联网项之一：NDK、rust std、首次 Gradle 构建，三处都要联网）

```powershell
& 'F:\Android\android-sdk\cmdline-tools\7.0\bin\sdkmanager.bat' --sdk_root='F:\Develop\Android\Sdk' --list |
    Select-String 'ndk;\d'
```

从列表里挑**最新稳定**的 `ndk;xx.y.z`（不带 `-beta`/`-rc`），然后：

```powershell
& 'F:\Android\android-sdk\cmdline-tools\7.0\bin\sdkmanager.bat' --sdk_root='F:\Develop\Android\Sdk' 'ndk;xx.y.z'
$env:NDK_HOME = 'F:\Develop\Android\Sdk\ndk\xx.y.z'
Get-Content "$env:NDK_HOME\source.properties"
```

期望：`Pkg.Revision = xx.y.z`；`$env:NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin\` 里有
`aarch64-linux-android24-clang.cmd` 与 `llvm-ar.exe`（这台设备是 API 29，用 API 24 的 clang 编译完全够；
`cc` crate 找不到 `…24-clang.cmd` 时会退到 `…21-clang.cmd`，所以 P0-4 里我们**显式**指到 24，不吃这个默认值）。
失败分支：卡在 license → 先跑 `... --licenses` 逐条同意；下载超时 → 换网络再跑（`--sdk_root` 必须指主 SDK，别装进第二个 SDK）。

### P0-3 加 rust target

```powershell
rustup target add aarch64-linux-android
rustup target list --installed
```

期望：列表里出现 `aarch64-linux-android`（**只装 aarch64**）。
依据：这台机的 `abilist` 是 `arm64-v8a,armeabi-v7a`，真机就是 arm64；不用模拟器就不装 `x86_64-linux-android`。
armv7 要不要装：**先不装**（它只在给 32 位老机出包时才需要，而且会引入 `-latomic` 之类的额外链接问题）。

### P0-4 cargo 交叉编译探针（最便宜、最早暴露问题的一步）

```powershell
$env:CC_aarch64_linux_android  = 'aarch64-linux-android24-clang.cmd'
$env:AR_aarch64_linux_android  = 'llvm-ar.exe'
$env:PATH = "$env:NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin;$env:PATH"
cargo build --target aarch64-linux-android -p gently-core
```

期望（**第一次跑大概率失败，失败点是 §3.1**）：

- 失败：`error: couldn't read .../rquickjs-sys-0.7.0/src/bindings/aarch64-linux-android.rs`
  → 这正是缺绑定，按 §3.1 拍板后处理后**重跑本步**；
- 失败：`linker 'cc' not found` / `unable to find library -l...` → `$env:PATH` 里没有 NDK bin（`cc` 是 `Command::new` 查 PATH 的）；
- 通过：`Finished`（本步只出 `.rlib`，**不链接**，所以它不是「能装到手机」的证明）。

### P0-5 生成移动工程

```powershell
pnpm tauri android init
git status --short          # 必须看：它改了/加了什么，把 diff 贴回来
```

期望：出现 `src-tauri/gen/android/`（含 `app/build.gradle.kts`、`gradlew`），`git status` 里主要是未跟踪的 `gen/android` 与少量配置改动。
失败分支：
- 报 `NDK_HOME` / `ANDROID_HOME` 未设 → 回到 P0-1/P0-2（`init` 也要求这两个变量）；
- 报权限/ACL 找不到 `core:window:allow-*` → 见 §3.2，先记下错误签名；
- 首次会拉 Gradle 发行包（`services.gradle.org` 实测可达）与 AGP（走 `dl.google.com`）。

### P0-6 装到真机并启动

```powershell
pnpm tauri android dev
```

期望：编译出 `libgently_lib.so` → Gradle 打包 → `adb install` → 手机上出现 **gently**（界面是迷你播放器）。
失败分支：
- `Could not resolve com.android.tools.build:gradle` → §5 风险 1（值得先看一眼）；
- `NDK at … did not have a source.properties` / 版本不匹配 → 换 `ndk;` 版本；
- 链接报 `undefined symbol: __android_log_*` → API level/链接参数问题（把 `CC_/AR_` 与 linker 都显式指到 `…android24-clang`）；
- 装上了但白屏 → 见 §3.2 的 capability 结论。

### P0-7 收证据（这就是本轮交付物）

```powershell
& 'F:\Develop\Android\Sdk\platform-tools\adb.exe' logcat -d > release\android-p0-logcat.txt
& 'F:\Develop\Android\Sdk\platform-tools\adb.exe' shell run-as com.xun.gently cat files/logs/gently.log.<日期> > release\android-p0-core.log
```

期望：`android-p0-core.log` 里出现 §1 第 3 条那三行（`version=8` 表示 8 条迁移都在真机上跑过了）。
若 logcat 里没有 Rust 输出：先看 `run-as` 读到的日志文件（控制台走 logcat，落盘走 `files/logs/`，两条路总有一条通）。

### P0-8（P1 之后才做）插件沙箱在真机上跑一次

导入 `examples/plugins/gently-demo.js` → 搜索 → 沙箱建运行时并返回结果。
这才是 §3.1 那份 FFI 绑定的**正确性**证明（编译通过只证明签名能对得上）。

## 5. 风险登记（每条都写「怎么知道它发生了」）

| # | 风险 | 失效信号（怎么发现） | 对策 |
|---|---|---|---|
| 1 | Gradle/AGP 拉不下来 | 卡在 `Could not resolve com.android.tools.build:gradle:` 或 `Connection reset` | `maven.google.com` 不通但 `dl.google.com/dl/android/maven2` 通（取到 200），Gradle 用的是后者，**大概率没事**；逐端点 HTTP 码本会话没能判定（§2 网络行），真卡住就加一个 Maven 镜像（在 `settings.gradle.kts` 的 `repositories` 前面插一条），并在本文件记录「加了什么、怎么撤」 |
| 2 | QuickJS 绑定缺失 | `couldn't read .../bindings/aarch64-linux-android.rs` | §3.1 的 B/A/C（**待拍板**） |
| 3 | NDK 与 AGP 版本不匹配 | `NDK at ... did not have a source.properties` / `Unsupported NDK` | 换一个 `ndk;` 版本（26 / 27 两条线） |
| 4 | API level / atomics | 链接期 `undefined symbol: __android_log_print`、`__atomic_*` | 把 `CC_/AR_/CARGO_TARGET_*_LINKER` 全指到 `…android24-clang`；armv7 才需要额外 `-latomic`（本轮不装 armv7） |
| 5 | capability 拒权限（白屏但进程活着） | 界面空白、`run-as` 日志里有 ACL 拒绝 / `listen` 失败 | §3.2：`tauri.android.conf.json` 单窗 + `platforms` 限定的 capability |
| 6 | 真机是 mini 形态 | 看到的就是迷你播放器 | **预期**，不是 bug；P1 解决 |
| 7 | 凭据后端降级 | 诊断信息里 `credentialsBackend=memory` | 预期：Android 分支没有 Keystore 接入，P3 才做；届时必须在界面如实显示 |
| 8 | 离线约定被打破 | 本机 `cargo` 缓存缺 crate、Gradle 要联网 | P0 期间允许联网；把每一步「联了什么、缓存到哪」记进 §6，之后恢复离线开发 |

## 6. 执行记录（每完成一步就贴在这里，一条都不要省）

| 步 | 日期 | 命令（原样） | 实际输出/错误签名 | 结论 |
|---|---|---|---|---|
| P0-0 | 2026-11-01 | `adb devices -l` + `adb shell getprop ro.product.cpu.abilist / ro.build.version.sdk` | `MKB6R20514007949 device product:CDY-AN00 model:CDY_AN00` / `arm64-v8a,armeabi-v7a` / `29` | ✅ 通过（真机可用，只装 aarch64 目标） |
| 准备 | 2026-11-01 | `cargo test -p gently-core --offline`（vendored patch 之后） | `Compiling rquickjs-sys v0.7.0 (…\vendor\rquickjs-sys)`；82 单元 + 全部集成测试通过 | ✅ patch 生效、桌面端行为未变（Android 侧仍未验，见 §3.1） |
| P0-1 | | | | |
| P0-2 | | | | |
| P0-3 | | | | |
| P0-4 | | | | |
| P0-5 | | | | |
| P0-6 | | | | |
| P0-7 | | | | |

> 规则：**「未运行」不许写成「通过」**（组内规范与 GOTCHAS 都吃过这个亏）。
> 失败时贴**错误签名 + 原始命令**，不贴结论；成功时贴**能复现的证据位置**（日志文件、截图）。

## 7. P1–P4（本轮不做，先定顺序与入口条件）

| 阶段 | 内容 | 入口条件 | 关键点 |
|---|---|---|---|
| **P1 移动外壳** | 第 4 形态 `mobile`：底部 tab（排行/发现/搜索/本地/我的）+ 单栏内容 + 常驻迷你播放条；mini 在移动端停用 | P0 绿 | `platform` 维度用 `system.status.platform`（真机上是 `android-aarch64`）判，**不引入新依赖**；列定义在 `table.config.tsx` 旁加一份 `mobileColumns`；`@media` 不进视图；smoke 加 mobile 形态断言 |
| **P2 后台播放** | 前台服务 + MediaSession + 通知栏控制 | P1 绿 **且** 先做一次实测：锁屏 5 分钟 WebView `<audio>` 是否还活着 | 这一步决定「WebView 播放 + 保活」还是「原生 Media3 播放器」——**先测再选**，别现在拍；后者会让播放状态要有唯一权威（store 是权威，原生只做输出层） |
| **P3 导入与存储** | SAF 选文件/目录（插件、皮肤、音乐目录）、下载导出、Keystore 凭据 | P1 绿 | `<input type=file>`、`path` 粘贴在 Android 上不成立；只留下 SAF 一条路 |
| **P4 桌面歌词替代** | 通知栏歌词 / 悬浮窗歌词 | P2 的前台服务 | 复用 `useDesktopLyricsBridge` 的快照，不重写歌词逻辑；悬浮窗要 `SYSTEM_ALERT_WINDOW` 特殊权限 |

宠物（pet-core）在移动端的渲染器属于 ADR 0010 的未决项，**不在 P0–P4 里**，等安卓能跑起来再单独排。

## 8. 结论（原「待拍板」，已定）

1. **QuickJS 绑定：选 B（vendored patch），已落地**（2026-11-01）。桌面端已用
   `cargo test -p gently-core` 验过（patch 生效、沙箱测试全绿）；Android 侧的编译与运行仍待 P0-3/P0-4/P0-8。
   详见 §3.1。
2. **P0 绿了之后是否立即进 P1**：等你看到 P0 的真机证据再定（我的建议仍是「是」——
   P0 起来的界面只有迷你播放器，不进 P1 就等于没产出）。

## 9. 相关文档

- 环境自检脚本（只读，每一步前后跑一次）：`scripts/android-env.ps1`
- 现状与缺口（本文件的依据）：[`ANDROID-INFRA-ASSESSMENT.md`](ANDROID-INFRA-ASSESSMENT.md)
- 可沿用的概念与「桌面专属不能搬」清单：[`DESIGN-REUSE.md`](DESIGN-REUSE.md)
- 契约（命令/事件/错误码，跨平台唯一权威）：[`contracts/local-core-api.md`](contracts/local-core-api.md)
- 非显然的坑（移动端新坑请按同格式补一节）：[`GOTCHAS.md`](GOTCHAS.md)
- 本轮状态与历史：[`STATE.md`](STATE.md)
