---
status: active
last_verified: 2026-11-02
owner: gently
scope: 安卓端**执行计划**：P0 的逐步命令、期望输出、失败分支与验收证据；P1–P4 的拆分、验收口径与落地记录
token_budget: 1900
tldr: 安卓**同一仓库 + `src-tauri/gen/android` + 真机 USB**，P0（工具链）当天跑通，此后 P1 外壳、P2-1 前台服务、P2-3 续播、P3-1 SAF 导入陆续落地。每一步都留了一条「怎么验」的口径（熄屏 4 分钟 +253 秒、冷启动续播、SAF 选文件入库），**下一步是 P2-2（MediaSession + 通知栏传输控制）与 P4**。P0 期间查出三件必须记住的事：① `rquickjs-sys 0.7` 缺 android 绑定（vendored patch 解决）；② 多窗口配置下移动端加载的是 `?window=pet` 那一份 → 白屏，需 `tauri.android.conf.json` 只留 main 窗；③ `--apk` 默认四 ABI，armv7 仍缺绑定，只出 arm64 要加 `-t aarch64`。
---

# ANDROID-PLAN：安卓端筹备与 P0–P4

> 结论先行：安卓**可行**，但本轮的目标不是「适配 UI」，而是**先把工具链钉死**。
> 现状评估见 [`ANDROID-INFRA-ASSESSMENT.md`](ANDROID-INFRA-ASSESSMENT.md)（缺什么、为什么）；
> 本文件只写「按什么顺序做、每条命令的期望输出、怎么才算验收、失败找谁」。

## 0. 已拍板的四件事（2026-11-01，用户决定）

| 维度 | 决定 | 含义 |
|---|---|---|
| 工程形态 | **同一仓库**，Tauri 标准移动路径 `src-tauri/gen/android` | 复用同一份 `core`、同一份 React 前端、同一套契约守卫；不新建工程、不复制契约 |
| 本轮范围 | 先做 **P0（工具链跑通）** | P1 外壳 / P2 后台播放 / P4 通知栏歌词都不在当时那一轮；后续按 §7 的顺序推进（P1、P2-1、P2-3、P3-1 已落地） |
| 验收设备 | **真机 + USB 调试**（不建 AVD） | 只装 `aarch64-linux-android`（不装 x86_64 / armv7） |
| 执行方式 | **我出命令与验收口径，你手动执行** | 命令涉及工作区外目录（`$env:ANDROID_HOME`、`%USERPROFILE%\.rustup`、`~/.gradle`）与联网下载，不由我代跑 |

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
   & '$env:ANDROID_HOME\platform-tools\adb.exe' shell run-as com.xun.gently ls -l logs
   & '$env:ANDROID_HOME\platform-tools\adb.exe' shell run-as com.xun.gently cat logs/gently.log.<日期>
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
| Android SDK（主） | ✅ `$env:ANDROID_HOME`：platforms `android-30/34/35/36`、build-tools `30.0.3/34.0.0/35.0.0`、`platform-tools`(adb) | 目录枚举 |
| `cmdline-tools`（sdkmanager 7.0） | ⚠️ 只在**另一个** SDK：`（另一份 SDK，含 cmdline-tools）` | 装包时用 `--sdk_root` 指回主 SDK |
| NDK | ✅ `ndk\28.2.13676358`（r28c），含 `aarch64-linux-android24-clang.cmd` | `source.properties` |
| `ANDROID_HOME` / `NDK_HOME` | ⚠️ 用户级/会话级设置；**`tauri android …` 必须在设了这两个变量的同一会话里跑**（否则 CLI 退回 `%LOCALAPPDATA%\Android\Sdk` 并报 cmdline-tools 缺失） | 实测报错 |
| `~/.gradle` | ✅ 已有缓存（Gradle 发行包 + AGP 已落盘） | 目录枚举 |
| `src-tauri/gen/android` | ✅ 已生成并入库（含 `MainActivity.kt`、`gradle-wrapper`、`jniLibs` 符号链接） | `git ls-files src-tauri/gen` |
| 连接的真机 | ✅ `<设备序列号>` · 真机 · `arm64-v8a,armeabi-v7a` · **API 29（Android 10）** | `adb devices -l` + `getprop` |
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

> 约定：以下命令都在仓库根目录 `<repo>` 的 pwsh 里跑；
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
& '$env:ANDROID_HOME\platform-tools\adb.exe' devices
```

期望：一行 `<序列号>	device`。
**当前状态**：`<设备序列号>` · 真机 · `arm64-v8a,armeabi-v7a` · **API 29（Android 10）**。
失败分支（换设备/换线时会用到）：`unauthorized` → 手机上点「允许 USB 调试」；无任何行 → 换数据线 / 打开「USB 调试（安全设置）」/ 装厂商 USB 驱动。

### P0-1 环境变量（会话级）

```powershell
$env:ANDROID_HOME = '$env:ANDROID_HOME'
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
& '$env:ANDROID_HOME\platform-tools\adb.exe' install -r `
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
& '$env:ANDROID_HOME\platform-tools\adb.exe' shell run-as com.xun.gently cat logs/gently.log.<日期>
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
| 11 | ~~安卓 WebView 播不出声~~ → **已定案：不是解码问题**（R110） | 点播放后播放条出现、进度在走但没声音；logcat `DEMUXER_ERROR_COULD_NOT_OPEN: open context failed` + `MEDIA_ELEMENT_ERROR … Network error` | **真凶**：上游用 **HTTP 200 + HTML 错误页** 回应媒体地址（实测取出的正是网易云「网页找不到」页，102 752 字节）——插件给的地址早就不服务音频了，`<audio>` 解码失败只是**症状**。代理现在把「回了什么」记下来：`媒体响应 status=… content_type=… sniffed=…`，认出不是音频还有一条 WARN（GOTCHAS §56）。**顺带修好的**：`Content-Type` 改为按**字节**嗅探（fMP4/ID3/fLaC/OggS/RIFF-WAVE/ADTS/webm），插件声明的 `mimeType` 不再被丢掉，回环代理补 `Access-Control-Allow-Origin: *`。**移动端播放链路已在真机验证**（本地文件 206 + `aria-valuenow` 5→13/271，见 §7.3） |

## 6. 执行记录（每完成一步就贴在这里，一条都不要省）

| 步 | 日期 | 命令（原样） | 实际输出/错误签名 | 结论 |
|---|---|---|---|---|
| P0-0 | 2026-11-01 | `adb devices -l` + `adb shell getprop ro.product.cpu.abilist / ro.build.version.sdk` | `<设备序列号> device product:<机型> model:<机型>` / `arm64-v8a,armeabi-v7a` / `29` | ✅ 通过（只装 aarch64） |
| 准备 | 2026-11-01 | `cargo test -p gently-core --offline`（vendored patch 之后） | `Compiling rquickjs-sys v0.7.0 (…\vendor\rquickjs-sys)`；82 单元 + 全部集成测试通过 | ✅ patch 生效、桌面端行为未变 |
| P0-1/2/3 | 2026-11-01 | `sdkmanager --sdk_root=… 'ndk;28.2.13676358'`；`rustup target add …` | `Pkg.Revision = 28.2.13676358`（r28c）；`aarch64` + `armv7`/`i686`/`x86_64` 均装 | ✅ 完成（`tauri android …` 必须与 `ANDROID_HOME`/`NDK_HOME` 在同一会话） |
| P0-4/5 | 2026-11-01 | `pnpm tauri android init` → `pnpm tauri android build --debug` | Rust 阶段完成 arm64 交叉编译；`gen/android` 生成并入库 | ✅ 完成 |
| P0-6 | 2026-11-01 | `pnpm tauri android build --debug -t aarch64 --apk` + `adb install -r` | 首次四 ABI 构建在 armv7 处失败：`couldn't read …/bindings/armv7-linux-androideabi.rs`；加 `-t aarch64` 后产出 `app-universal-debug.apk`（328 MB），`Performing Streamed Install / Success`，`lastUpdateTime=19:2x` | ✅ 完成（armv7 见风险 9） |
| P0-7 | 2026-11-01 | `adb shell run-as com.xun.gently cat logs/gently.log.2026-11-01` | 8 条迁移 + `数据库就绪 … version=8` + `宠物核心就绪 …/pet`；截图 `dsh-final2.png`（迷你播放器空态） | ✅ 完成（路径是 `logs/` 不是 `files/logs/`） |
| 白屏排查 | 2026-11-01 | `adb logcat` 过滤 `Tauri/Console`；解包 APK 看 `assets/` | 页面 URL 是 `index.html?window=pet`（多窗口取最后一项）→ 空宠物页；dev 包 `assets/` 只有 `tauri.conf.json` | ✅ 加 `tauri.android.conf.json`（单窗）后界面正常 |

> 规则：**「未运行」不许写成「通过」**（组内规范与 GOTCHAS 都吃过这个亏）。
> 失败时贴**错误签名 + 原始命令**，不贴结论；成功时贴**能复现的证据位置**（日志文件、截图）。

## 7. P1–P4：顺序、入口条件与落地记录

| 阶段 | 内容 | 入口条件 | 关键点 |
|---|---|---|---|
| **P1 移动外壳** | 第 4 形态 `mobile`：**左侧抽屉（8 项）+ 搜索作 home + 常驻播放条**（不做推荐/排行榜）；mini 在移动端停用 | ✅ P0 已绿 | `platform` 维度用同步的 `utils/platform.ts`（UA 判 `Android`），外壳形态要**首帧**定下来；列定义在 `table.config.tsx` 旁加一份 `mobileColumns`；`@media` 不进视图；smoke 加 mobile 形态断言 |
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

### 7.2 R109：P1-4/5/6 的实现口径（结论）

> 三片都只动**交互层与列定义**，store / 服务层 / 契约一个字没改。逐条取舍与真机走查见
> [`archive/rounds/R101-R117.md`](archive/rounds/R101-R117.md) 的附录。

- **列表**：`table.config.tsx` 加 `mobileColumns` / `mobileTrackColumns`（手机 3 列 = 主信息 `1fr` + 时长 + ⋯），
  `DataTable` 用**纯函数** `resolveColumns(shell, columns, mobileColumns)` 裁决；手机隐藏表头，单元格留白收到
  `--space-2`（桌面 18px 会把「4:18」挤成 `4…`）。视图里不写 `@media`。
- **触摸语义**：手机不渲染行内小按钮，唯一入口是 `MobileRowActions` 的 ⋯（44px）→ `RowActionsProvider` 底部面板
  （动作与桌面同源，仍走 `useTrackActions`）；**没有宿主时退回行内按钮**，不留「点了没反应」的入口。
  面板宿主挂在 `MobileShell` **外层**（带 `backdrop-filter` 的容器会抢包含块）、关闭挂根 `<div>` 的 onClick
  （透明 `<button>` 当遮罩在真机上既不涂色也收不到点击）。
- **SeekBar**：手机下焦点常显、热区 32px 且**只往播放条内部扩**；`MobilePlayerBar` 的 `.bar` 必须
  `position: relative`，否则绝对定位的 SeekBar 会锚到应用顶边（关掉动态背景后没有别的包含块）。
- **窗口能力**：`window.service.ts` 的 `desktopWindowActionsAvailable(tauri, mobile)` 让最小化/置顶/浮动等在移动端
  no-op 并**如实**返回「没有这个能力」；桌面歌词桥 / 宠物桥在移动端本就不挂。

### 7.3 P2–P3 的落地记录（每片一条结论，证据在归档）

| 轮 | 片 | 落地内容 | 证据 / 坑 |
|---|---|---|---|
| R110 | 播放链路定案 | 真机**能放音**；「播不出声」的真凶是上游用 **HTTP 200 + HTML 错误页**冒充媒体。核心侧把 `Content-Type` 改成**先嗅探字节**（fMP4/ID3/fLaC/OggS/RIFF-WAVE/ADTS/webm），插件声明的 `mimeType` 不再被丢，回环代理补 CORS，日志记 `status / content_type / sniffed` | 本地文件 206 + `aria-valuenow` 5→13/271；GOTCHAS §56 |
| R111 | P2 入口条件实测 | 熄屏后测出**三种形态**（音频停住 → 位置僵死但 `paused=false` → 页面被整页重载），`pidof` 全程没变 → **P2 定为「WebView 播放 + 前台服务」**（不做原生 Media3）。前端补中断恢复：`play()` 3 秒上限、`isStalled()` 判僵死、`markInterrupted()` 停表并提示「点播放继续」 | 三种形态的原始读数在归档；GOTCHAS §57 |
| R112 | P2-1 前台服务 | Kotlin `PlaybackService`（`startForeground` 必须 5 秒内调）+ `gently-playback` 渠道 + 常驻通知；`PlaybackPlugin` 由宿主命令 `playback_banner` 驱动，前端只在「在播/停/换歌」推一次。清单需要 `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK`（targetSdk 36） | 熄屏 4 分钟 `5/271 → 258/271`（+253 秒）；`isForeground=true foregroundId=1001`；GOTCHAS §58 |
| R113 | P2-3 续播 | `utils/lastPlayback.ts`（纯函数校验、10 秒节流、**只存一首歌不存队列**）+ `toggle()` 的「没有地址的暂停」→ `recoverPlayback()`；`seek()` 不再在元素未建时放弃 | 真机 `150/271` → 冷启动 → 点播放 `156/271`；GOTCHAS §59 |
| R114 | P3-1 SAF 导入 | Kotlin `ImportPlugin`（`ACTION_OPEN_DOCUMENT`，`audio/*` 多选）在**后台线程**拷进 `<filesDir>/music`（同名不覆盖、**零存储权限**）→ `src-tauri/src/importer.rs` + 宿主命令 `import_audio` → `ScanPanel` 手机形态的「从手机导入音频」→ `library.local.scan` 入库 | 真机选 1 首 → 列表出现、磁盘有文件、扫描新增 1；`r114-android-import.png` |
| R115 | P2-2 MediaSession + 传输控制 | `PlaybackService` 用 framework 的 `MediaSession`（不引 androidx.media）：`MediaMetadata` + `PlaybackState`（`PLAY/PAUSE/SKIP_NEXT/SKIP_PREV`），通知用 `Notification.MediaStyle` 挂三个按钮（上一首 / 播放·暂停 / 下一首）；用户按按钮 → 服务只把动作（`toggle/next/prev`）经 `MediaActionBridge`（`evaluateJavascript` 调页面里的 `window.__gentlyMediaAction`）送回前端，**改 store 的永远是页面** | 真机 `KEYCODE_MEDIA_PAUSE` 后进度冻在 `6`、`KEYCODE_MEDIA_PLAY` 6→10、`KEYCODE_MEDIA_NEXT` 换歌且通知标题跟着变；`dumpsys media_session` 里 `state=3/2` 与 `actions=566`；通知栏三按钮截图 `r115-android-notification.png` |
| R116 | P4 通知栏歌词 | 歌词**只在页面算**（`currentLyricLine()` 取当前行，没有歌词就是空串）→ 播放条的 `line` 作为第 5 个参数一路传到 `playback_banner` / `playback::update` / Kotlin `EXTRA_LINE`；服务把它写进 `Notification` 的 `setContentText`（空串回落成歌手）与 `MediaMetadata` 的 `DISPLAY_SUBTITLE`。前端去重键 `playbackBannerKey()` 加上 `line`，**只有换行才推一次**，不逐帧打扰原生 | 真机同一张通知原地把第二行从「第一句：夜色温柔」改成「第二句：灯火未眠」（`r116-android-lyrics-notification-1/2.png`）；`dumpsys media_session` 里 `metadata: size=3`、`state=3` |
| R117 | P2-2 余项：位置 / 时长 + 自有通知图标 | `PlaybackState` 不再给 `PLAYBACK_POSITION_UNKNOWN`：前端把 `position`/`duration`（毫秒）一起推下来，服务写进 `setState(state, position, speed)` 与 `METADATA_KEY_DURATION`（暂停时速度必须 0，播放中靠系统按 1× 推算，所以**不需要**每秒推）。**不声明 `ACTION_SEEK_TO`**：锁屏拖动要走 `onSeekTo` 回页面，还没接——「声明了但不生效」比不声明更坏（§46）。通知小图标换成自己的音符矢量（`res/drawable/ic_gently_notification.xml`） | 冷启动恢复 231 s → 点播放 `position=231200`；点进度条 50% → `135465`；媒体键暂停 → `state=2 speed=0.0 position=240154`；`metadata: size=4`（含时长）。两个真机坑见 GOTCHAS §62；`r117-android-notification.png`（♪ 图标） |
| R118 | P3 余项：任意封装都能导入 | 真机实测：`audio/*` 过滤会把 `.m4s` **灰掉**（同一个文件改名 `.mp3` 就能选），而 `.m4s` 是 B 站音频的常见封装。改成 `*/*` + `EXTRA_MIME_TYPES=[audio/*, application/octet-stream]`，选完由 `isAudioName()` 按扩展名筛（名单与核心 `AUDIO_EXTENSIONS` 一一对应），跳过数如实回报 `skipped`；导入结果文案抽成纯函数 `utils/importNote.ts` | `.m4s` 可选 → 「已导入 1 首」→ 列表出现 → 能放（`8/271`）；选 `not-audio.bin` → 「选中的 1 个文件都不是音频」且磁盘没多文件；`r118-android-import-m4s.png` / `-skipped.png`；GOTCHAS §63 |

| R119 | P3 余项：清理导入副本 | 导入是「拷一份」，而「移除」只移出曲库、**文件留在磁盘**——私有目录只涨不清。新宿主命令 `imported_dir`（Kotlin 回 `<filesDir>/music`，前端不猜）+ `importedMusicDir()` 缓存 + 纯函数 `importedTracksOf`（按路径前缀挑副本；拿不到目录就一条不删）+ `purgeImported()`（要删的正在播就先停，逐条 `library.local.remove{deleteFile:true}`）；`ScanPanel` 手机形态给「应用内已导入 N 首（副本）」+「清理副本」+ 危险确认 | 真机：曲库 3 首 → 「已清理 2 首」→ `run-as ls files/music` 变**空**、`probe`（不在导入目录）留下、正在播的已停播；`r119-android-clean-entry.png` / `-confirm.png` / `-cleaned.png` |

| R120 | 收口走查（9 个路由）+ 修 4 个真机问题 | `scripts/probes/route-audit.js`：`pushState` + `popstate`（react-router 听它，不整页重载）逐个进 8 个抽屉项 + `/now-playing`，记溢出/外壳/可疑文案/console 报错。修掉：首页「「」共 0 首」→ `subtitleIdle`；抽屉品牌行被状态栏压住（绝对定位不继承 shell 的 `padding-top`）；手机上的「在文件夹中显示」假入口（`revealInDirAvailable`）；**进度条 32px 热区吃掉播放条按钮上 21px 的点击**（改成以进度线为中心的带状热区，播放条让 `--space-3` 的带） | 9 个页面全部 `overflow=0 / hasShell=true / suspicious=[] / newErrors=[]`；`elementFromPoint(200,831)`→进度条、`(158,858)`→打开播放页；拖动 `30→137`、点标题区进 `/now-playing`；`r120-android-drawer-fixed.png` / `-row-sheet-mobile.png` / `-now-playing.png` / `-notification.png`；GOTCHAS §64 |

| R126 | 用户反馈 #3 尾项：手机形态再收两处桌面项 | 设置页「发现页自动试听」用 `!mobile` 包起来（手机 8 个入口里没有「发现」页） | `pnpm typecheck` / `pnpm smoke` 通过；真机文本核对见 STATE R126 |
| R123 | 用户反馈 #2 歌词区尺寸 / #6 移动端过渡 + 安装包体积 | 手机端封面只在背景层、不占布局，但歌词卡片在「封面作为背景」时掉回桌面档高度；过渡：抽屉遮罩淡入 + 面板左滑、换页轻微上浮淡入 + 回到顶部，`prefers-reduced-motion` 下关闭；构建期虚拟模块 `virtual:gently-bundled-bg`（android 回 null）把 110 MB 演示视频从移动端产物里去掉 | 真机：背景模式歌词卡片 640（修复前 516）；`_pageIn_/_drawerIn_/_scrimIn_` 三个动画名在生效；`TAURI_ENV_PLATFORM=android pnpm build` 的 `dist/assets` 无 mp4、桌面构建仍有；debug APK **671 → 328 MB** |
| R122 | 用户反馈 #7 背景适配 / #9 滚动重影 | 真机诊断：`background.asset` 为空时会退回**内置 100 MB+ 演示视频**（`src/assets/bgc.mp4`）→ 手机一进应用就解码大文件、背景迟到、表面忽然变半透明+毛玻璃；19px 毛玻璃盖在动图上让滚动文字糊成一片。修：手机形态不用内置演示视频（只认用户导入的素材）、默认无毛玻璃 + 内容/抽屉不透明度下限 0.92、背景层淡入 | 真机冷启动后：无背景层、`data-video-bg` 未设置、`--surface-chrome: #ffffff`、`--surface-blur: none`；列表白底深字（`r122-android-local-opaque.png`）；GOTCHAS §66 |
| R121 | 用户 10 条体验问题的第一批（#4 / #8 / #3+#10） | **#4** 最近播放重复且全部高亮 → 聚合放核心：`library.history.list` 用窗口函数改成「每首歌一行」（最近一次播放 + 累计 `playCount`，`total` 是歌数）。**#8** 抽屉去掉 ✕（`mobile.close` 一并删）：新增 `hooks/useBackToClose`——浮层打开时压一条同 URL 历史标记，系统返回先 pop 它 → 关浮层而不是退回上一页；抽屉与行操作面板都接上，点空白也能关。**#3/#10** 手机形态隐藏宠物 / 桌面歌词 / 网页壁纸助手 / 下载目录路径 / 诊断，数据目录只剩一句「系统分配、不能迁移」；本地页隐藏「每行一个目录」输入框与说明，提示语换手机版 | 真机：一首播 2 次 + 另一首 3 次 → `history.list` 返回 `total: 2`（playCount 2 / 3）、最近播放两行只高亮一行；抽屉无 ✕、点空白关闭且路由不变、系统返回关闭且不退出；设置页无桌面专有块；smoke 555；GOTCHAS §65 |

| R128 | #3 尾项：手机形态不再提供「网页（静态单文件）」背景 | 背景类型选项按 `isMobilePlatform()` 分流：手机只有「视频」（网页背景是把单个 HTML 塞进 iframe 的桌面玩法），桌面两种都在、历史配置不清 | `pnpm typecheck` / `pnpm smoke` 通过（`kindWeb` 仍被桌面分支引用，死键守卫通过） |
| R130 | #10 尾项：手机上下载落在哪 | 下载卡片在手机形态多一句「落在应用私有目录、卸载一并删除」（与数据目录卡片同一说法）；桌面仍显示目录输入框 | `pnpm smoke` 555 |
| R133 | #5 动画穿模：第一刀 | 浮层（抽屉 / 行操作面板）打开时给 `<html>` 打 `data-overlay="open"`（抽屉与面板共用 `useBackToClose`，标记只在一处维护），CSS 压掉底层 `:active` 高亮与过渡。交付时只到门禁层 | 真机复核在 R134 补上（并量出两处偏差） |
| R134 | #5 动画穿模：真机复核 + 修两处偏差 | 真机用 CDP `CSS.forcePseudoState` 强制 `:active` 读 computed、`document.getAnimations()` 数「浮层外还剩几条」：① 行规则与 `.table[data-layout='mobile'] .row:active` 同为 0,4,0，平局靠源码顺序 → 只压住过渡没压住背景色；② R133 的全局 `button:active` 越界到浮层自身。修：抑制收窄到顶栏 + 内容区按钮（`html[data-overlay='open']`），行的覆盖写进 `DataTable.module.css` 并提到 0,4,1 | 真机：顶栏/行/⋯ 强制 `:active` 后全透明、抽屉项与面板动作按钮保留 `--bg-active`、浮层打开后浮层外 0 条动画、标记随开关清理；`r134-android-drawer.png` / `-row-sheet.png`；smoke 555；GOTCHAS §68 |

| R135 | 收尾清单里的「上游不是音频」进 UI 文案 | 新命令 `playback.diagnose{ref}`：回环代理转发时按字节判定（`audio` / `notAudio` / `unknown`；非 2xx 与认不出的封装不下结论），按曲目引用记账、新 `playback.resolve` 清旧判定；前端只在媒体失败判死分支问一次，`notAudio` 就换成新失败类型，文案「音源返回的不是音频（错误页 / 需要登录 / 链接已失效）」 | `cargo test -p gently-core` +5 断言；`pnpm smoke` **562**；契约 76 条命令 / 9 类事件；无真机视觉复核（需要真的回错误页的上游，仓库不内置，ADR-0005）；GOTCHAS §56 补充 |

| R136 | P3 余项：导入进度条 | Kotlin `ImportPlugin` 维护 `Progress` 快照（active / fileName / fileIndex / fileCount / bytesDone / bytesTotal / imported / failed / skipped）：拷贝改成 64 KiB 分块累加，先按 SAF `SIZE` 算总字节，跳过与截断都补差额；宿主加 `import_progress` 命令（桌面端 `{active:false}`），`ScanPanel` 导入期间 250ms 轮询并显示「正在导入 1/1 · 文件 · 45%」 | 真机导入 1.3 GB：40 秒窗口 16 个不同快照（`bytesDone` 194MB→1.32GB）、结束 `bytesDone==bytesTotal` + `imported:1`；界面截图 `r136-android-import-progress.png`；导入后曲库 4→5、清理副本回到 1；smoke 566；GOTCHAS §69 |

| R137 | 移动端反馈批次（后台播放 / 滑动开抽屉 / 导航项 / 歌词页返回 / 列表去卡片 / 白屏兜底） | 后台播放抓到现场：华为 WebView 页面不可见时拒绝 `play()`（`hbs_autoplay_=0`），且第一版后台恢复走 `resume()→reload()` 每 5s 清零进度（熄屏 150s 只走 13s）→ 改成只 `nudge()`、看门狗隐藏时不判失败；抽屉支持从内容区横滑打开（避开屏幕左边缘的系统返回、播放条排除、时间戳只吃紧接的 click）；`useBackToClose` 的 `history.back()` 与异步 `navigate` 抢历史导致「点导航项没反应」→ 换页用 `replace` 顶掉标记；设置页白屏本机未复现，加 `RouteError` 错误边界；手机歌词页去掉「返回」；手机列表拆外层卡片改连续列表 | 真机：横滑 `250→800` 开抽屉、播放条横滑不开；冷启动第一次导航即成功、连续 8 次 0 失败且历史每次只 +1；系统返回 `/now-playing` → `/setting` → `/search`；`r137-mobile-list-flat.png`；smoke 575；GOTCHAS §70 |

**下一步（P3 余项 / P2-2 余项）**：P2-2 只差两件——`ACTION_SEEK_TO` + `onSeekTo` 回页面（锁屏/车机拖进度，
要先确认能真机验到才接）、`POST_NOTIFICATIONS` 运行时授权入口（API 33+ 才需要；本机 API 29 验不了）。
注意本机 ROM（EMUI 10 / Android 10）的通知、控制中心、锁屏卡片**都不画进度条**，位置数据的可见面要等
Android 11+ 或车机/蓝牙（§7.3 R117）；P3 只剩**音乐目录导出**（导入进度条已在 R136 落地）。**后台播放的硬骨头**（WebView 后台拒绝 `play()`）留给下一轮：让 `PlaybackService` 的 MediaSession 主动持有音频焦点（`requestAudioFocus`），或页面侧维护 `navigator.mediaSession`——两者都要 ≥5 分钟真机长测（GOTCHAS §70）。
**体验类问题（R121 起的收口批次）已全部落地**：手势（返回关浮层、面板下拉收起；左边缘横滑是负结果，GOTCHAS §67）、
歌词页尺寸、桌面专有项、最近播放去重、动画穿模与过渡、背景适配、滚动重影、storage 适配（逐轮见 R121–R134）。


**拆分（每片独立可交付）**

| 片 | 内容 | 完成标准 |
|---|---|---|
| P1-1 | `resolveShellMode` 第 4 形态 + `platform.service` + App 分支骨架 | typecheck/smoke 绿；真机上出现 `mobile` 骨架（空内容也可） |
| P1-2 | `MobileShell`：底部 5 tab + 内容区 + 更多抽屉 | 真机能进 6 个主路由 |
| P1-3 | 移动播放条（复用 MiniPlayer）+ `/now-playing` 入口 | 点播放条进歌词页，返回不丢状态 |
| P1-4 | 触摸语义：SeekBar 常显手柄、行内动作收进底部面板、hover→active | 真机可拖进度、可收藏/下载（走底部面板） |
| P1-5 | `mobileColumns` + 各列表两行式呈现 | 列表在 360px 宽下不横向溢出 |
| P1-6 | 窗口能力 no-op + 桥不挂 + 截图与文档 | 真机无报错；桌面截图无变化 |
| P2-1 | **前台服务**保活 + 常驻通知（Kotlin Service + Tauri 移动插件桥） | 熄屏/后台继续播（实测熄屏 4 分钟 +253 秒）；停播即退出服务 |
| P2-2 | MediaSession + 通知栏传输控制 + 进度/时长 + 通知图标（R115，位置与图标 R117，`SEEK_TO` 未接） | 通知上能播放/暂停/上下曲，且状态回写 store |
| P2-3 | 页面被系统重载后的续播（R113 已落地） | 冷启动后播放条有歌、位置正确、点播放从该位置接着放 |
| P3-1 | **SAF 导入**（系统文件选择器 → 拷进应用目录 → 扫描入库，R114 已落地） | 真机选文件后列表里出现该曲目；不需要存储权限 |

**P1 不做**：后台播放（P2）、SAF 导入（P3）、通知栏/悬浮窗歌词（P4）、平板横屏专用布局（先用 `compact` 顶）、
宠物渲染器、armv7 打包。

## 8. 结论

1. **QuickJS 绑定：选 B（vendored patch），已落地并已跨平台验证**。桌面端 `cargo test -p gently-core` 全绿；
   **arm64 Android 构建也通过**（日志里 `Compiling rquickjs-sys v0.7.0 (…\vendor\rquickjs-sys)`）。
   还剩「运行时正确性」（P0-8：真机导一次 demo 插件）与 armv7 绑定（风险 9）。
2. **P0 已完成**（2026-11-01）：工具链、构建、安装、启动、真机日志、界面渲染六件都有证据（§1、§6）。
3. **P1 已完成**（R108 外壳 + R109 触摸语义/手机列/窗口能力）：手机外壳 = 左侧抽屉（8 项）+ 搜索作 home +
   常驻播放条（不含推荐/排行榜）；列表两行式、行操作进 ⋯ 底部面板、进度条在播放条顶边且常显焦点。
   逐片状态与证据见 §7.1、§7.2。
4. **播放链路已定案（R110）**：真机上**能放音**（本地文件走同一条回环代理，206 + 进度推进）；
   「播不出声」的真凶是上游用 HTTP 200 + HTML 错误页冒充音频（风险 11）。诊断工具
   `scripts/android-cdp.mjs`（真机 CDP）与代理的「回了什么」日志是一对，别再靠 logcat 里的
   解码错误去猜。
5. **P2 / P3 / P4 全部落地**（R112–R119）：前台服务保活（熄屏 4 分钟 +253 秒）、MediaSession 与通知栏
   传输控制（R115）、冷启动续播（R113）、SAF 导入且**任意封装都能选**（R114/R118）、导入副本清理（R119）、
   通知栏歌词（R116）与真实位置/时长 + 自有通知图标（R117）。
6. **收口走查（R120）**：9 个路由逐个走一遍——无横向溢出、无 console 报错、空态都有文案；
   顺手修掉四个真机问题（首页副标题、抽屉被状态栏压住、手机上的「在文件夹中显示」假入口、
   进度条热区抢按钮点击）。**移动端开发到此收口**。
7. **收尾清单（都不是阻塞项，本机也验不了或价值很低）**：
   - `ACTION_SEEK_TO` + `onSeekTo` 回页面（锁屏/车机拖进度）——本机 ROM 不画进度条，接了也验不到；
   - `POST_NOTIFICATIONS` 运行时授权入口——只有 API 33+ 才有意义，本机 API 29；
   - ~~导入进度条~~ → **R136 已落地**（原生快照 + `import_progress` 轮询，真机 1.3 GB 导入 16 个快照，见 GOTCHAS §69）；
     音乐目录导出仍挂着；
   - ~~「上游返回的不是音频」进 UI 文案~~ → **R135 已落地**（与桌面端共用：`playback.diagnose` + `notAudio` 失败类型，
     见 GOTCHAS §56）；
   - 平板横屏专用布局（先用 `compact` 顶）、宠物渲染器、armv7 打包。

## 9. 相关文档

- 环境自检脚本（只读，每一步前后跑一次）：`scripts/android-env.ps1`
- 现状与缺口（本文件的依据）：[`ANDROID-INFRA-ASSESSMENT.md`](ANDROID-INFRA-ASSESSMENT.md)
- 可沿用的概念与「桌面专属不能搬」清单：[`DESIGN-REUSE.md`](DESIGN-REUSE.md)
- 契约（命令/事件/错误码，跨平台唯一权威）：[`contracts/local-core-api.md`](contracts/local-core-api.md)
- 非显然的坑（移动端新坑请按同格式补一节）：[`GOTCHAS.md`](GOTCHAS.md)
- 本轮状态与历史：[`STATE.md`](STATE.md)
