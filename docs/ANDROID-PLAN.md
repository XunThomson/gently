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

## 8. 结论

1. **QuickJS 绑定：选 B（vendored patch），已落地并已跨平台验证**。桌面端 `cargo test -p gently-core` 全绿；
   **arm64 Android 构建也通过**（日志里 `Compiling rquickjs-sys v0.7.0 (…\vendor\rquickjs-sys)`）。
   还剩「运行时正确性」（P0-8：真机导一次 demo 插件）与 armv7 绑定（风险 9）。
2. **P0 已完成**（2026-11-01）：工具链、构建、安装、启动、真机日志、界面渲染六件都有证据（§1、§6）。
3. **下一步是 P1**（等用户决定）：当前真机上只有一个迷你播放器空态，「能跑不能用」——P1 做完才算能看能用。

## 9. 相关文档

- 环境自检脚本（只读，每一步前后跑一次）：`scripts/android-env.ps1`
- 现状与缺口（本文件的依据）：[`ANDROID-INFRA-ASSESSMENT.md`](ANDROID-INFRA-ASSESSMENT.md)
- 可沿用的概念与「桌面专属不能搬」清单：[`DESIGN-REUSE.md`](DESIGN-REUSE.md)
- 契约（命令/事件/错误码，跨平台唯一权威）：[`contracts/local-core-api.md`](contracts/local-core-api.md)
- 非显然的坑（移动端新坑请按同格式补一节）：[`GOTCHAS.md`](GOTCHAS.md)
- 本轮状态与历史：[`STATE.md`](STATE.md)
