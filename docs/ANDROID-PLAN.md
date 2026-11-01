---
status: active
last_verified: 2026-11-01
owner: gently
scope: 安卓端**执行计划**：P0（工具链跑通）的逐步命令、期望输出、失败分支与验收证据；P1–P4 的范围与顺序
token_budget: 1900
tldr: 用户 2026-11-01 决定重启安卓：**同一仓库 + `src-tauri/gen/android`**、**真机 USB**、先只做 **P0**。**P0 当天跑通**：NDK r28c + 4 个 android target + `gen/android` + arm64 debug APK 装到 `CDY-AN00`（API 29）并启动，真机日志出现 8 条迁移、`数据库就绪 … version=8`、`宠物核心就绪`；界面渲染出迷你播放器空态。过程中查出三件必须记住的事：① `rquickjs-sys 0.7` 缺 android 绑定（已按 vendored patch 解决，arm64 通过）；② **多窗口配置下移动端加载的是 `?window=pet` 那一份** → 白屏，需 `tauri.android.conf.json` 只留 main 窗；③ `--apk` 默认四 ABI，**armv7 仍缺绑定**，只出 arm64 要加 `-t aarch64`。
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

## 1. P0 的验收定义 —— **✅ 已达成（2026-11-01）**

1. ✅ `cargo build --target aarch64-linux-android -p gently-core` 通过 —— 证明 `rusqlite`(bundled SQLite)、
   `rquickjs`(QuickJS C)、`ring`(rustls 汇编) 三条 C/asm 依赖都能过 NDK 交叉编译（实测在
   `pnpm tauri android build -t aarch64` 的 Rust 阶段完成，日志里有 `Compiling rquickjs-sys v0.7.0 (…\vendor\rquickjs-sys)`）；
2. ✅ `src-tauri/gen/android` 生成，arm64 debug APK（328 MB，`app-universal-debug.apk`）装到真机并**启动**；
3. ✅ 真机上读到核心自己写的日志（**路径是 `/data/user/0/com.xun.gently/logs/`，不是 `files/logs/`**）：

   ```
   应用迁移 migration="0001_init" … → migration="0008_recommend_feedback"
   SQLite 就绪 schema_version=8 migrations=8
   数据库就绪 db=/data/user/0/com.xun.gently/gently.db version=8
   宠物核心就绪 dir=/data/user/0/com.xun.gently/pet
   ```

   取法（debug 包 debuggable，`run-as` 可读）：

   ```powershell
   & 'F:\Develop\Android\Sdk\platform-tools\adb.exe' shell run-as com.xun.gently ls -l logs
   & 'F:\Develop\Android\Sdk\platform-tools\adb.exe' shell run-as com.xun.gently cat logs/gently.log.<日期>
   ```

   > 计划里原先要求第三行是 `数据目录：…（来源 …）`——**那行是 `eprintln!`，在日志初始化之前打，
   > 只进 logcat、不进日志文件**。所以验收以日志文件里的三行（8 条迁移 / 数据库就绪 / 宠物核心就绪）为准。
   >
   > 为什么用日志而不是「打开设置页看诊断卡」：真机竖屏约 412 CSS px，`resolveShellMode` 判成 **mini**，
   > `App.tsx` 的 mini 分支不渲染路由与侧栏，**设置页进不去**（实测界面就是迷你播放器的空态，见 §3.3）。

**P0 明确不证明的事**（不要在这些上给「通过」）：
插件沙箱（QuickJS）**没有在真机上跑过** —— 沙箱只在用户动作 `catalog.search` 之后 `ensure_loaded` 才建运行时，
所以 FFI 绑定是否 ABI 正确，要等 P1 有设置页之后导一个 demo 插件才知道（P0-8）。

## 2. 环境事实（2026-11-01 复测；P0 完成后 `scripts/android-env.ps1` 全绿）

| 项 | 状态 | 依据 |
|---|---|---|
| rustc / cargo | ✅ 1.97.1 | `rustc -V` |
| rust android targets | ✅ `aarch64-linux-android` + `armv7-linux-androideabi` / `i686-linux-android` / `x86_64-linux-android` | `rustup target list --installed` |
| JDK | ✅ 17.0.12，`JAVA_HOME` 已设 | `java -version` |
| Android SDK（主） | ✅ `F:\Develop\Android\Sdk`：platforms `android-30/34/35/36`、build-tools `30.0.3/34.0.0/35.0.0`、`platform-tools`(adb) | 目录枚举 |
| `cmdline-tools`（sdkmanager 7.0） | ⚠️ 只在**另一个** SDK：`F:\Android\android-sdk` | 装包时用 `--sdk_root` 指回主 SDK |
| NDK | ✅ `ndk\28.2.13676358`（r28c），含 `aarch64-linux-android24-clang.cmd` | `source.properties` |
| `ANDROID_HOME` / `NDK_HOME` | ⚠️ 用户级/会话级设置；**`tauri android …` 必须在设了这两个变量的同一会话里跑**（否则 CLI 退回 `C:\Users\Xun\AppData\Local\Android\Sdk` 并报 cmdline-tools 缺失） | 实测报错 |
| `~/.gradle` | ✅ 已有缓存（Gradle 发行包 + AGP 已落盘） | 目录枚举 |
| `src-tauri/gen/android` | ✅ 已生成并入库（含 `MainActivity.kt`、`gradle-wrapper`、`jniLibs` 符号链接） | `git ls-files src-tauri/gen` |
| 连接的真机 | ✅ `MKB6R20514007949` · `CDY_AN00`（nova 7 SE 5G）· `arm64-v8a,armeabi-v7a` · **API 29（Android 10）** | `adb devices -l` + `getprop` |
| 联网（构建期端点） | ⚠️ **本会话仍无法判定**：子进程 HTTPS 全部失败（`schannel: SEC_E_NO_CREDENTIALS`）；但**真实构建成功证明了网络可用**（NDK 下载、Gradle/AGP 拉取、`--debug` 构建全程完成） | 构建成功即证据 |
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

### 3.2 移动端将就的 capability 与**必须改的多窗口配置**（已实测，已修）

- `src-tauri/capabilities/default.json` 绑 `desktop-schema.json`，并申请了 `core:window:allow-minimize` /
  `toggle-maximize` / `set-always-on-top` / `set-ignore-cursor-events` 等桌面权限；
  **实测：Android 构建与启动都没有被 ACL 卡住**（core 日志与 WebView 都正常），所以这次**没有**拆 `mobile.json`
  （保持「跑通了就不预先改」）。真遇到 ACL 拒绝再拆，签名记 §6。
- ✅ **`tauri.conf.json` 的三个窗口必须给移动端单独覆盖**：实测移动端只起一个 webview，加载的是
  **`index.html?window=pet`**（即最后一个窗口配置），于是 `main.tsx` 走 `PetWindowApp` 分支 —— 没有宠物时
  什么都不画 → **整屏白**（核心日志却一切正常，极具误导性）。
  修法（已落地）：`src-tauri/tauri.android.conf.json` 只留一个 `main` 窗口；Tauri CLI 会自动合并平台配置，
  数组整体替换。加了这个文件之后 APK 里 `assets/tauri.conf.json` 的 `windows` 才只剩一项。

### 3.3 真机界面就是迷你播放器（✅ 实测，P0 的预期现象）

`src/utils/shellMode.ts`：`宽 < 720 或 高 < 480 → mini`；真机 1080×2400 / dpr 3 → 360 CSS px 宽，落进 mini。
实测截图：左上标题 `gently` + 空态「**还没有播放歌曲** / 点右上角「展开」回到完整界面选一首歌」。
**这不是 bug，也不是「跑通了 UI」**：那行提示是桌面语义（移动端没有「恢复窗口」这一步）。
第 4 种形态 `mobile` 属于 P1 —— 这是 P1 必须先做的直接理由。

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

### P0-2 装 NDK —— ✅ 已完成：`ndk;28.2.13676358`（r28c）

### P0-3 加 rust target —— ✅ 已完成（装了 `aarch64` 以及 `armv7`/`i686`/`x86_64` 三个额外的）

### P0-4 cargo 交叉编译探针 —— ✅ 已完成（在 `pnpm tauri android build -t aarch64` 里真编过 arm64）

```powershell
$env:CC_aarch64_linux_android  = 'aarch64-linux-android24-clang.cmd'
$env:AR_aarch64_linux_android  = 'llvm-ar.exe'
$env:PATH = "$env:NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin;$env:PATH"
cargo build --target aarch64-linux-android -p gently-core
```

失败分支（都吃过或已验证过）：
- `couldn't read .../bindings/aarch64-linux-android.rs` → §3.1 的绑定缺失（已用 vendored patch 解决）；
- `linker 'cc' not found` / `unable to find library -l...` → PATH 里没有 NDK bin（`cc` 是 `Command::new` 查 PATH 的）。

### P0-5 生成移动工程 —— ✅ 已完成（`src-tauri/gen/android` 已入库）

### P0-6 装到真机并启动 —— ✅ 已完成，两条路都走过（**结论：验证 UI 用 `--debug` 构建，别用 dev 包**）

```powershell
# 路线 A（dev 包）：需要一个 dev server，离开它 WebView 就是白屏（APK 里只有 assets/tauri.conf.json）
pnpm tauri android dev

# 路线 B（自带前端资源的 debug 包，推荐用来验收 UI）：
pnpm tauri android build --debug -t aarch64 --apk
& 'F:\Develop\Android\Sdk\platform-tools\adb.exe' install -r `
    'src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk'
```

失败分支（实测）：
- `Blocking waiting for file lock on Android` + 后面一堆 `Couldn't find callback id` → **不是错误**：另一个
  `tauri android` 进程还在（先结束它）；那串警告来自移动端误加载的 pet 窗口页（见 §3.2，加单窗配置后消失）。
- `Port 1420/1421 is already in use` → 上一轮 vite 还在；`tauri android dev` 的 `beforeDevCommand` 必须独占 1420。
- **`--apk` 默认四 ABI**：`armv7-linux-androideabi` 目前没有绑定 → `couldn't read …/armv7-linux-androideabi.rs`。
  只出 arm64：`-t aarch64`（见 §5 风险 9）。
- 装 328 MB 的 debug 包**超过 120 秒**，别用短超时的前台命令等 `adb install`。

### P0-7 收证据 —— ✅ 已完成

```powershell
& 'F:\Develop\Android\Sdk\platform-tools\adb.exe' shell run-as com.xun.gently cat logs/gently.log.<日期>
```

注意两点（都踩过）：数据目录是 **`/data/user/0/com.xun.gently`**（日志在 `logs/`，不在 `files/logs/`）；
`screencap` 前必须 `svc power stayon true` + `KEYCODE_WAKEUP`，否则设备熄屏会截出一张**纯白图**。

### P0-8（P1 之后才做）插件沙箱在真机上跑一次

导入 `examples/plugins/gently-demo.js` → 搜索 → 沙箱建运行时并返回结果。
这才是 §3.1 那份 FFI 绑定的**正确性**证明（编译通过只证明签名能对得上）。

## 5. 风险登记（每条都写「怎么知道它发生了」）

| # | 风险 | 失效信号 | 状态 / 对策 |
|---|---|---|---|
| 1 | Gradle/AGP 拉不下来 | `Could not resolve com.android.tools.build:gradle:` | ✅ 未发生（真实构建完成）；万一卡住就加 Maven 镜像并记录「加什么、怎么撤」 |
| 2 | QuickJS 绑定缺失 | `couldn't read …/bindings/aarch64-linux-android.rs` | ✅ 已解（vendored patch，arm64 构建通过，`cargo test -p gently-core` 全绿） |
| 3 | NDK 与 AGP 版本不匹配 | `NDK at ... did not have a source.properties` | ✅ 未发生（r28c + AGP 8.14 组合可用） |
| 4 | API level / atomics | `undefined symbol: __android_log_print` / `__atomic_*` | ✅ 未发生（Tauri 自己注入 `-landroid -llog -lOpenSLES`，链接器指向 `…android24-clang`） |
| 5 | 白屏但进程活着 | 界面全白、日志正常 | ✅ **真实发生过，根因不是 ACL 而是多窗口**（§3.2）。加载的是 `?window=pet` → 空宠物页 |
| 6 | 真机是 mini 形态 | 看到迷你播放器 | **预期**；P1 解决 |
| 7 | 凭据后端降级 | `credentialsBackend=memory` | 预期（Android 走内存实现）；P3 才接 Keystore |
| 8 | 离线约定被打破 | cargo 缓存缺 crate、Gradle 要联网 | P0 期间允许联网；本次联网项：NDK、rust std、Gradle 发行包 + AGP、crates（Android 专用 crate 已在缓存里） |
| 9 | **armv7 绑定缺失** | `couldn't read …/armv7-linux-androideabi.rs` | 只出 `-t aarch64`（当前设备够用）；要支持 32 位老机时，需要按同样办法补 armv7 绑定（不能用 i686 那份顶替：ARM EABI 的 double 对齐与 i386 不同），并处理 `-latomic` |
| 10 | 用 dev 包验收 UI | APK 里只有 `assets/tauri.conf.json`；dev server 不在就白屏 | 验收 UI 一律用 `android build --debug`；`dev` 只用于热更新开发 |
| 11 | **安卓 WebView 播不出声（未解）** | 点搜索结果后播放条出现曲目，但音频元素报 `DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed` / `error_code = 102_091005 ... Network error`，随后 `pauseForBindings` | 已排除「连不上代理」：核心日志有 `本地流代理已启动（仅回环） port=…` + `媒体连接已接受` + `媒体请求 method=GET target=/m/…`；debug 包 `usesCleartextTraffic=true`（build.gradle 里占位符，debug 段为 true）。**下一步**：① 先在桌面同源上抓一次 `playback.resolve` 的 origin 与 `effective_content_type` 结果（`core/src/media.rs` 在「上游给 octet-stream 且地址没有扩展名」时**不发 Content-Type**，安卓 Chromium 可能因此拒绝）；② 换 `bili-audio` 源再试（`wangyiyun` 的取流可能需要登录，返回的不是音频）；③ 必要时开 `GENTLY_LOG=debug` 看代理回的状态码 |

## 6. 执行记录（每完成一步就贴在这里，一条都不要省）

| 步 | 日期 | 命令（原样） | 实际输出/错误签名 | 结论 |
|---|---|---|---|---|
| P0-0 | 2026-11-01 | `adb devices -l` + `adb shell getprop ro.product.cpu.abilist / ro.build.version.sdk` | `MKB6R20514007949 device product:CDY-AN00 model:CDY_AN00`（nova 7 SE 5G）/ `arm64-v8a,armeabi-v7a` / `29` | ✅ 通过（只装 aarch64） |
| 准备 | 2026-11-01 | `cargo test -p gently-core --offline`（vendored patch 之后） | `Compiling rquickjs-sys v0.7.0 (…\vendor\rquickjs-sys)`；82 单元 + 全部集成测试通过 | ✅ patch 生效、桌面端行为未变 |
| P0-1/2/3 | 2026-11-01 | `sdkmanager --sdk_root=… 'ndk;28.2.13676358'`；`rustup target add …` | `Pkg.Revision = 28.2.13676358`（r28c）；`aarch64` + `armv7`/`i686`/`x86_64` 均装 | ✅ 完成（`tauri android …` 必须与 `ANDROID_HOME`/`NDK_HOME` 在同一会话） |
| P0-4/5 | 2026-11-01 | `pnpm tauri android init` → `pnpm tauri android build --debug` | Rust 阶段完成 arm64 交叉编译；`gen/android` 生成并入库 | ✅ 完成 |
| P0-6 | 2026-11-01 | `pnpm tauri android build --debug -t aarch64 --apk` + `adb install -r` | 首次四 ABI 构建在 armv7 处失败：`couldn't read …/bindings/armv7-linux-androideabi.rs`；加 `-t aarch64` 后产出 `app-universal-debug.apk`（328 MB），`Performing Streamed Install / Success`，`lastUpdateTime=19:2x` | ✅ 完成（armv7 见风险 9） |
| P0-7 | 2026-11-01 | `adb shell run-as com.xun.gently cat logs/gently.log.2026-11-01` | 8 条迁移 + `数据库就绪 … version=8` + `宠物核心就绪 …/pet`；截图 `dsh-final2.png`（迷你播放器空态） | ✅ 完成（路径是 `logs/` 不是 `files/logs/`） |
| 白屏排查 | 2026-11-01 | `adb logcat` 过滤 `Tauri/Console`；解包 APK 看 `assets/` | 页面 URL 是 `index.html?window=pet`（多窗口取最后一项）→ 空宠物页；dev 包 `assets/` 只有 `tauri.conf.json` | ✅ 加 `tauri.android.conf.json`（单窗）后界面正常 |

> 规则：**「未运行」不许写成「通过」**（组内规范与 GOTCHAS 都吃过这个亏）。
> 失败时贴**错误签名 + 原始命令**，不贴结论；成功时贴**能复现的证据位置**（日志文件、截图）。

## 7. P1–P4（本轮不做，先定顺序与入口条件）

| 阶段 | 内容 | 入口条件 | 关键点 |
|---|---|---|---|
| **P1 移动外壳** | 第 4 形态 `mobile`：底部 tab（排行/发现/搜索/本地/我的）+ 单栏内容 + 常驻迷你播放条；mini 在移动端停用 | ✅ P0 已绿 | `platform` 维度用 `system.status.platform`（真机上是 `android-aarch64`）判，**不引入新依赖**；列定义在 `table.config.tsx` 旁加一份 `mobileColumns`；`@media` 不进视图；smoke 加 mobile 形态断言 |
| **P2 后台播放** | 前台服务 + MediaSession + 通知栏控制 | P1 绿 **且** 先做一次实测：锁屏 5 分钟 WebView `<audio>` 是否还活着 | 这一步决定「WebView 播放 + 保活」还是「原生 Media3 播放器」——**先测再选**；后者要让播放状态有唯一权威（store 是权威，原生只做输出层） |
| **P3 导入与存储** | SAF 选文件/目录（插件、皮肤、音乐目录）、下载导出、Keystore 凭据 | P1 绿 | `<input type=file>`、`path` 粘贴在 Android 上不成立；只留下 SAF 一条路 |
| **P4 桌面歌词替代** | 通知栏歌词 / 悬浮窗歌词 | P2 的前台服务 | 复用 `useDesktopLyricsBridge` 的快照，不重写歌词逻辑；悬浮窗要 `SYSTEM_ALERT_WINDOW` 特殊权限 |

宠物（pet-core）在移动端的渲染器属于 ADR 0010 的未决项，**不在 P0–P4 里**。

### 7.1 P1 细化方案（2026-11-01 **已按用户要求改过两版**，P1-1/2/3 已落地）

> 用户的两次要求（都已生效）：
> ① **安卓不做推荐与排行榜**（`/ranking`、`/hot` 不进移动导航）；
> ② **搜索页就是 home**，**导航放左侧抽屉**（不要底部 tab）。

**形态判定（第 4 种 `mobile`）**

- `src/utils/shellMode.ts` 的 `resolveShellMode` 加**第 4 个入参** `platform?: 'desktop' | 'mobile'`：
  `platform === 'mobile'` → 恒 `mobile`（不看尺寸）；其余逻辑与现在完全一致（纯函数，smoke 直接钉）。
- 平台来源：`src/utils/platform.ts` 的**同步**判定（安卓 WebView 的 UA 含 `Android`）。
  为什么不用异步的 `system.status.platform`：外壳形态要在**首帧**定下来，异步会先闪一下桌面三栏；
  数据能力仍一律以核心为准。**不引入 `@tauri-apps/plugin-os`**。
- `App.tsx`：`mobile` 分支渲染 `<MobileShell/>`（抽屉 + 内容 + 常驻播放条）；`mini` 分支在移动端**不再触发**。
- 根路径：手机端重定向到 **`/search`**（`MOBILE_HOME_PATH`），桌面端仍是 `/ranking`。

**导航结构（左侧抽屉，8 项；数据只在 `nav.tsx` 一处）**

| # | 入口 | 路由 |
|---|---|---|
| 1 | 搜索（**home**） | `/search` |
| 2 | 本地音乐 | `/local` |
| 3 | 下载管理 | `/download` |
| 4 | 最近播放 | `/recent` |
| 5 | 我的收藏 | `/favorites` |
| 6 | 插件管理 | `/plugin` |
| 7 | 主题市场 | `/theme` |
| 8 | 设置 | `/setting` |

抽屉 = 遮罩 + 左滑面板（宽 `--mobile-drawer-width`，最大 82%），点遮罩关闭；高亮按**前缀**匹配
（`/download/downloading` 仍算「下载管理」）。不做成路由页：它只是导航，做成页面会多一层返回。

**搜索框放哪**

桌面搜索框长在标题栏里；手机没有标题栏，所以 `MobileSearchBar` 在 **`/search` 下**单独一行
（其余页面不占这一行高度）。搜索历史 / 防抖参数与桌面**同源**（`theme.config.json` 的 `searchBox` 段）。

**播放条与歌词页**

- 移动端播放条：**新写一个紧凑条**（`MobilePlayerBar`），与桌面 `PlayerBar` / `MiniPlayer` **共用零件**
  （`Cover`、`SeekBar`、store 的 player 切片与 actions），只按手机宽度重排；点主体 → `/now-playing`。
  ⚠️ 与原计划「复用 MiniPlayer 整页」不同：MiniPlayer 是整页布局（含窗口按钮与歌词块），塞不进 62px 的条，
  所以复用的是**零件与状态**，不是那一页。
- **手机歌词页默认省略封面**（用户 2026-11-01 要求：歌词才是主角），歌词卡片改用更高的高度
  （`--now-playing-mobile-lyrics-height`，把封面省下的高度还回来）；右上角一个开关可在
  「封面已省略 / 封面作为背景」之间切换，开启后封面铺满、压暗 + 虚化作为背景层
  （`--now-playing-mobile-cover-opacity` / `-blur`），歌词压在上面。
  偏好只影响手机、存 localStorage（`utils/nowPlayingCover.ts`，与桌面歌词窗口设置同一种做法），
  桌面仍是「封面 + 歌词」两栏。**这个开关在桌面端不存在**。
- `/now-playing` 现有的「功能抽屉」保留（收藏/下载/歌单），触摸下改为点击展开。

**触摸语义（只改交互层，不改 store）**

- `SeekBar`：触屏常显手柄（`@media (hover: none)` 或 `data-shell` 开关），拖拽热区 ≥ 24px；桌面保持悬浮才显示。
- 列表行：「点当前曲目 = 播放/暂停、点其他 = 切歌」**语义不变**（`useTrackActions` 不动）；
  行内动作按钮在移动端**不渲染**，改由「点行右侧 ⋯ → 底部操作面板」复用 `useTrackActions` 的同一批动作。
- 所有 `:hover` 反馈在 `data-shell="mobile"` 下退化为 `:active`。
- 发现页「划过即试听」：移动端不提供该页（不做推荐），所以这条在安卓端不需要。

**列表宽度**

- `src/config/table.config.tsx` 旁加一份 `mobileColumns`（两行式：标题/歌手 + 右侧时长），
  由 `useShellMode()` 决定用哪一份；**视图里不写 `@media`**，也不新增 `useViewport`。

**窗口能力（全部按平台分支，桌面行为不变）**

- `title-bar`：移动端不渲染（外壳自己只有一个「抽屉按钮 + 标题」）。
- `window.service.ts`：`minimize / toggleMaximize / setAlwaysOnTop / pip / restoreFromMini` 在移动端 no-op 并如实返回。
- 桌面歌词 / 宠物窗口：移动端 `useDesktopLyricsBridge` / `usePetWindowBridge` 直接不挂（P4 再做替代品）。
- 状态栏：安卓是 edge-to-edge，`app.config.mobile.statusBarInset = 30`（本机量出来的近似值）用来让出状态栏高度；
  精确值等宿主上报（P2）。

**验收（缺一不算）**

1. `pnpm typecheck && pnpm smoke` 绿，且新增断言：`resolveShellMode` 四形态、抽屉 8 项且不含推荐/排行榜、
   `MOBILE_HOME_PATH === '/search'`、抽屉高亮前缀匹配、桌面三形态**不回归**；
2. 真机 `android build --debug -t aarch64 --apk` 装机后：抽屉 8 项逐一点到、搜索能出结果、播放条 → 歌词页；
3. 截图（首页 + 抽屉 + 若干页面）存 `release/screenshots/r108-*.png`（`release/` 不入库，引用写进 STATE）；
4. 桌面端不得变：完整界面截图与 P0 前一致（`pnpm ui:capture` 对打包版各来一张）。

**进度（2026-11-01）**

| 片 | 状态 | 证据 |
|---|---|---|
| P1-1 形态 + 平台 + home 重定向 | ✅ | `resolveShellMode(412,915,bp,'mobile')==='mobile'`；真机落到 `/search` |
| P1-2 左侧抽屉（8 项） | ✅ | 真机截图：抽屉列出 8 项，「搜索」高亮 |
| P1-3 常驻播放条 + 搜索行 | ✅ | 真机截图：`还没有播放歌曲 / 从列表里挑一首开始`；搜索框 + 蓝色「搜索」按钮 |
| P1-4 触摸语义（SeekBar 常显手柄、行内动作收进底部面板） | ✅（R109） | 见下方「R109 落地说明」；`r109-android-sheet.png` / `-nowplaying.png` |
| P1-5 `mobileColumns` 列表两行式 | ✅（R109） | `r109-android-search-list.png`（两行式，360px 不溢出） |
| P1-6 窗口能力 no-op 收尾 + 桌面截图比对 | ✅（R109） | `desktopWindowActionsAvailable` 纯谓词 + smoke 断言；桥本就不挂；桌面截图见 STATE |

### 7.2 R109 落地说明（P1-4/5/6 的实现口径）

> 三片都只动**交互层与列定义**，store / 服务层 / 契约一个字没改。

**P1-5 列表（换一份列，不是压窄桌面列）**

| 项 | 决定 |
|---|---|
| 列定义 | `table.config.tsx` 新增 `mobileColumns(options)`（通用）与 `mobileTrackColumns(t, options)`（曲目专用）；手机 3 列 = `主信息(1fr) + 时长 + ⋯` |
| 谁选 | `DataTable` 新增 `mobileColumns` 属性 + `resolveColumns(shell, columns, mobileColumns)` **纯函数**：只有 `mobile` 形态且传了手机列才换 |
| 两行内容 | 第一行标题、第二行「歌手 · 附加 · 专辑」；附加信息按视图给（搜索=音源数量、本地=大小、最近=播放多久前、收藏=音源、下载=状态/进度） |
| 留白 | 手机单元格左右留白收到 `--space-2`（桌面 18px 会把「4:18」挤成 `4…`、⋯ 裁成两个点——R109 真机实测过一轮） |
| 表头 | 手机隐藏（`data-layout="mobile"`）：两行式已经说明是什么，留个只有「标题」的表头像坏掉 |
| 命中区 | ⋯ 是 44px 方块（`--mobile-row-action-size`）；`polished-ui/touch-interactions`：视觉可以小，命中区不能小 |

**P1-4 触摸语义**

| 项 | 决定 |
|---|---|
| 行内动作 | 手机上不渲染任何行内小按钮：`MobileRowActions` 是唯一入口，点开交给 `RowActionsProvider` 的**底部面板**（scrim + 抓手 + 48px 一行的动作，动作与桌面同源） |
| 面板宿主 | 挂在 `MobileShell` 外层（`<RowActionsProvider>` 包住 shell，面板是 shell 的兄弟节点）——放进带 `backdrop-filter` 的容器里会被当成包含块（GOTCHAS §54） |
| 关闭面板 | **挂在根 `<div>` 的 onClick 上**（面板自己 `stopPropagation`）。不能只靠那块透明 `<button>`：真机上它既不着色也收不到点击（GOTCHAS §55，实测点面板外关不掉） |
| 抽屉关闭 | 三条路：点遮罩 / 点面板右上角 **✕**（`mobile.close`）/ 选中一项。✕ 是因为遮罩命中区在真机不可靠 |
| 没有宿主时 | `MobileRowActions` **退回行内按钮**：宁可多几个按钮，也不要一个点了没反应的 ⋯（冒烟直接钉这条） |
| SeekBar | `:global([data-shell='mobile'])` 下焦点常显 + 热区 32px（`--mobile-progress-hit-height`），**只往播放条内部扩**，不抢内容区最下面一行的点击；触屏松手后清掉时间预览（没有 `pointerleave`） |
| SeekBar 锚点 | `MobilePlayerBar` 的 `.bar` 必须有 `position: relative`：SeekBar 自己是 `absolute; top: 0`，而 `backdrop-filter` 只在**关掉动态背景之前**才当包含块（`--surface-blur: none` 时没有）→ 少了它就跑到应用顶边（真机复现，smoke 有断言） |
| hover→active | 行、⋯、面板项都在手机形态下补了 `:active` 反馈 |
| 减少动效 | 面板动画 `@media (prefers-reduced-motion: reduce)` 直接关掉 |

**P1-6 窗口能力**

- `window.service.ts` 新增导出谓词 `desktopWindowActionsAvailable(tauri, mobile)`；`runDesktop()` 用它挡住
  `minimize / toggleMaximize / setAlwaysOnTop / setCompact / restoreFromMini`，`isMaximized / isAlwaysOnTop / onResized`
  在移动端直接给「没有这个能力」的诚实返回值（不再留下一条 `原生窗口操作失败` 的假故障日志）。
- `useDesktopLyricsBridge` / `usePetWindowBridge` 在移动端本就不挂（前者内部还有 `isMobilePlatform()` 早退），本轮核对确认，不需要改。

**真机走查（2026-11-01，`r108-android-*.png`）**

- ✅ 抽屉 8 项 + 搜索作 home（`-home` / `-drawer`）
- ✅ 搜索：输入 `love` → 共 39 首，音源筛选 chips 正常（`-search`）
- ✅ 点行播放：播放条显示 `Love / Keyshia Cole` + 封面（`-playing`）
- ✅ 播放条 → 歌词页：封面 + 歌名 + 歌词面板（已改单列，`-nowplaying`）
- ✅ **手机歌词页默认无封面**（歌词占满，`-lyrics-no-cover`），右上角开关切「作为背景」后封面虚化压暗铺底（`-lyrics-cover-bg`）
- ❌ **音频解码失败**（风险 11，未解）
- 🐞 已修：返回键把 `?q=` 弹掉但输入框还留着旧词（现在 URL 是唯一权威）；歌词页两栏挤成竖排（`data-stack` 现在含 `mobile`）

**R109 真机走查（2026-11-01，`r109-android-*.png`）**

- ✅ 列表两行式：`love` 39 首，每行「封面 + 标题 + 歌手·N 个音源·专辑」，右侧 `4:15` 与 ⋯ **完整不裁**（`-search-list`）
- ✅ 行操作面板：点 ⋯ → 底部面板「Love / 播放 / 收藏 / 下载」+ 背景压暗；点面板外空白关闭（`-actions-sheet`）
- ✅ 抽屉：8 项 + 内容压暗 + 右上角 ✕；点遮罩也能关（`-drawer`）
- ✅ 播放：行高亮 + 播放条；进度条在**播放条顶边**、触屏常显焦点，点一下跳 45%（`-playing` / `-seek`）
- ✅ 播放条 → 歌词页（手机默认省封面）（`-nowplaying`）
- 🐞 本轮真机才发现、已修：时长/⋯ 被单元格内边距裁字（`4…`、`⋯` 只剩两点）；遮罩色画在 button 上不涂也不收点击（GOTCHAS §55）；进度条锚到应用顶边（`.bar` 缺定位祖先）
- ❌ 音频解码失败仍在（风险 11）——UI 走查是在「模拟时钟」下完成的

**拆分（每片独立可交付）**

| 片 | 内容 | 完成标准 |
|---|---|---|
| P1-1 | `resolveShellMode` 第 4 形态 + `platform.service` + App 分支骨架 | typecheck/smoke 绿；真机上出现 `mobile` 骨架（空内容也可） |
| P1-2 | `MobileShell`：底部 5 tab + 内容区 + 更多抽屉 | 真机能进 6 个主路由 |
| P1-3 | 移动播放条（复用 MiniPlayer）+ `/now-playing` 入口 | 点播放条进歌词页，返回不丢状态 |
| P1-4 | 触摸语义：SeekBar 常显手柄、行内动作收进底部面板、hover→active | 真机可拖进度、可收藏/下载（走底部面板） |
| P1-5 | `mobileColumns` + 各列表两行式呈现 | 列表在 360px 宽下不横向溢出 |
| P1-6 | 窗口能力 no-op + 桥不挂 + 截图与文档 | 真机无报错；桌面截图无变化 |

**P1 不做**：后台播放（P2）、SAF 导入（P3）、通知栏/悬浮窗歌词（P4）、平板横屏专用布局（先用 `compact` 顶）、
宠物渲染器、armv7 打包。

## 8. 结论

1. **QuickJS 绑定：选 B（vendored patch），已落地并已跨平台验证**。桌面端 `cargo test -p gently-core` 全绿；
   **arm64 Android 构建也通过**（日志里 `Compiling rquickjs-sys v0.7.0 (…\vendor\rquickjs-sys)`）。
   还剩「运行时正确性」（P0-8：真机导一次 demo 插件）与 armv7 绑定（风险 9）。
2. **P0 已完成**（2026-11-01）：工具链、构建、安装、启动、真机日志、界面渲染六件都有证据（§1、§6）。
3. **P1 已完成**（R108 外壳 + R109 触摸语义/手机列/窗口能力）：手机外壳 = 左侧抽屉（8 项）+ 搜索作 home +
   常驻播放条（不含推荐/排行榜）；列表两行式、行操作进 ⋯ 底部面板、进度条在播放条顶边且常显焦点。
   逐片状态与证据见 §7.1、§7.2。**下一个入口条件是 P2（后台播放）**，先做一次「锁屏 5 分钟 WebView
   `<audio>` 还活着吗」的实测再决定技术路线；风险 11（音频解码失败）也归到 P2 一起解决。

## 9. 相关文档

- 环境自检脚本（只读，每一步前后跑一次）：`scripts/android-env.ps1`
- 现状与缺口（本文件的依据）：[`ANDROID-INFRA-ASSESSMENT.md`](ANDROID-INFRA-ASSESSMENT.md)
- 可沿用的概念与「桌面专属不能搬」清单：[`DESIGN-REUSE.md`](DESIGN-REUSE.md)
- 契约（命令/事件/错误码，跨平台唯一权威）：[`contracts/local-core-api.md`](contracts/local-core-api.md)
- 非显然的坑（移动端新坑请按同格式补一节）：[`GOTCHAS.md`](GOTCHAS.md)
- 本轮状态与历史：[`STATE.md`](STATE.md)
