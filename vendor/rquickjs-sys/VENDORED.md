# vendor/rquickjs-sys — 为什么要在这里放一份上游代码

**一句话**：`rquickjs-sys 0.7.0` 没有 `aarch64-linux-android` 的 FFI 绑定文件，Android 构建会在
`include!` 处直接编译失败；这里放一份补上该文件的上游快照，由根 `Cargo.toml` 的 `[patch.crates-io]` 接管。

## 来路（可核对）

| 项 | 值 |
|---|---|
| crate | `rquickjs-sys` |
| 版本 | `0.7.0`（与 `Cargo.lock` 里的一致，**没有升级**） |
| 上游 | <https://github.com/DelSkayn/rquickjs>（`rquickjs` 仓库的 sys crate） |
| 许可 | MIT（见 `Cargo.toml` 的 `license = "MIT"`；本 crate 没有随包 LICENSE 文件，QuickJS 本身也是 MIT） |
| 来源 | 本机 cargo registry 缓存 `registry/src/index.crates.io-*/rquickjs-sys-0.7.0` 的**逐文件副本**（未改动任何现有文件） |

## 改了什么（只有一处新增）

- **新增** `src/bindings/aarch64-linux-android.rs`：内容与 `aarch64-unknown-linux-gnu.rs` 逐字节相同。
  依据：两者都是 LP64、`long`/指针/`size_t` 宽度一致，`quickjs.bind.h` 里没有平台条件编译；
  未包含的指针类型也不会因 ABI 不同而变形。**这条推理的最终证明在真机**（见下面的「怎么算验证过」）。
- 现有文件（`build.rs`、`quickjs/*.c`、其它 target 的绑定）**一律未改**，因此桌面端行为不应有任何变化。

## 怎么算验证过（区分「已验」与「未验」）

- ✅ **已验（本机，2026-11-01）**：`cargo test -p gently-core` 全绿 —— 说明 patch 生效、
  宿主编译与插件沙箱（QuickJS 真实运行）行为没有变化；
- ❌ **未验**：Android 侧只在真机上跑一次插件沙箱（导入 `examples/plugins/gently-demo.js` → 搜索）
  才算 ABI 正确。在那之前，这份绑定属于「结构上正确、未经运行验证」。

## 怎么更新 / 怎么撤

- **更新**：升级 `rquickjs` 时不要手工改这里。先看新版本是否自带 android 绑定（`src/bindings/` 里有没有
  `aarch64-linux-android.rs`）；带了就把本目录与根 `Cargo.toml` 的 `[patch.crates-io]` 一起删掉，
  回到纯 registry 依赖。
- **撤掉**：删本目录 + 删 `Cargo.toml` 的 `[patch.crates-io]` 段 + 删 `[workspace]` 的 `exclude` 里那一项，
  然后 `cargo update -p rquickjs-sys`。桌面端不受影响；Android 端会回到「编译失败」。
- **禁止**：不要直接改 `~/.cargo/registry/src/**` 里的源码来绕过（换机器就不复现，且污染全局缓存）。

背景与三条路的取舍见 [`docs/ANDROID-PLAN.md`](../../docs/ANDROID-PLAN.md) §3.1。
