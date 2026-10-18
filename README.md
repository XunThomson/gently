# gently

一个**不依赖任何服务器**的桌面音乐播放器：Tauri（Rust 本机核心）+ React 19 + TypeScript。

- **无账号、无市场后端、无遥测**——所有能力都是本机核心的 Tauri 命令与事件
  （见 [`docs/adr/0003-no-server-local-core.md`](docs/adr/0003-no-server-local-core.md)）。
- **对第三方资源保持中立**：不内置、不推荐、不预置任何音源或资源入口；插件与皮肤
  一律由用户自行 clone / 下载 / 分享后**通用导入**（见
  [`docs/adr/0005-neutral-third-party.md`](docs/adr/0005-neutral-third-party.md)）。
  用户动作之前不会发起任何外部请求。
- 音乐源以 **插件** 形式接入：内嵌 QuickJS 沙箱、清单声明权限与域名白名单，
  安装必须「预览 → 用户显式同意 → 落盘」；兼容 MusicFree / LX 生态的 CommonJS 插件
  （双轨制见 [`docs/adr/0006-plugin-format-dual-track.md`](docs/adr/0006-plugin-format-dual-track.md)）。

## 结构

```
core/         Rust 本机核心（不依赖 tauri，可独立 cargo test）
src-tauri/    薄适配层：把核心能力暴露成一条 Tauri 命令 + 事件
src/          React 前端（views / store / services / components / theme / i18n）
docs/         契约、架构、路线图、ADR、STATE（当前迭代状态）
scripts/      契约守卫、冒烟测试、交付前验证、打包
```

数据流方向固定为：`views → store → services → (Tauri 命令) → core`。
UI 与 store **不得**直接 `invoke`，也不直接依赖某个具体插件。

## 快速开始

```bash
pnpm install

pnpm dev           # 浏览器预览：没有本机核心，数据来自 src/mock（页面完整可用）
pnpm tauri dev     # 桌面端：真实核心 + 本地 SQLite + 插件沙箱
```

浏览器预览是**开发态**的兜底，不是产品形态：真正的数据、持久化与插件都在桌面端。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm smoke` | 冒烟测试：状态层断言 + 全部组件可渲染 + i18n / CSS token / 契约守卫（362 项；含 **2.x 宠物接口** 6 项、**第三方授权** 9 项、**源收藏** 8 项与**缓存上限** 2 项——宿主空态 / 同 id 覆盖 / 旧注销不误删 / 只读快照 / 授权四条命令与参数 / 授权地址交给系统浏览器 / `auth:changed` 刷新状态；末尾用**假宿主**把「核心优先读 / 核心在时不退回 mock / 下载被拒 / 下载设置与并发 / 歌词搜索 / 缓存管理 / 桌面歌词载荷 / 皮肤裁决」等桌面端分支也跑一遍） |
| `pnpm check:contract` | 契约守卫：文档 ↔ Rust 命令/事件清单 ↔ 前端服务层与事件常量（含事件名字符集，双向） |
| `pnpm check:reachability` | 界面可达性守卫：每条契约能力是否**真的能从界面走到**（有实现有封装、却没人调用 → 失败；白名单要写理由） |
| `pnpm verify` | 交付前一次跑完**五道关卡**：typecheck + smoke + check:contract + check:reachability + `cargo test -p gently-core` |
| `pnpm build` | `tsc && vite build`（只构建前端） |
| `pnpm ui:capture` | （仅 Windows）截屏/驱动打包版做视觉走查：`pnpm ui:capture -- -Launch -AssertRendered -Output release/screenshots/boot.png -Kill` |
| `pnpm package:portable` | **离线可用的分发产物**：便携版 zip（输出在 `release/`） |
| `pnpm tauri build` | 出 MSI / NSIS 安装包（首次需要联网取打包工具，见下） |
| `cargo test -p gently-core` | 核心单测（218 项，不依赖 tauri，秒级） |

### 离线构建约定

本仓库的 crate 缓存固定在 `CARGO_HOME=F:\Develop\Rust\.cargo`（默认的 `~/.cargo` 里没有这份缓存），
因此 `pnpm verify` 默认给 cargo 加 `--offline`；需要联网拉依赖时用
`GENTLY_CARGO_ONLINE=1 pnpm verify`。

### 出包

```bash
pnpm package:portable     # → release/gently-<版本>-<平台>-<架构>.zip（含 exe、README、SHA256）
pnpm tauri build          # → MSI / NSIS 安装包（首次需要联网下载 WiX / NSIS 工具链）
```

安装包生成依赖 Tauri 的打包工具链（WiX / NSIS），**首次必须联网**下载一次；
拿不到网络时用 `pnpm package:portable`——便携版是同一个二进制，解压即用。

## 文档

| 文档 | 内容 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | 协作入口：硬约束、完成标准、红线（改代码前先读） |
| [`docs/contracts/local-core-api.md`](docs/contracts/local-core-api.md) | **本机核心契约**：命令 / 事件 / 错误码 / 插件与皮肤模型 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 分层、数据流、播放链路、i18n、契约边界 |
| [`docs/STATE.md`](docs/STATE.md) | 当前迭代状态：本轮做了什么、验证结果、下一步 |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | M0–M5 里程碑与退出标准 |
| [`docs/adr/`](docs/adr/) | 架构决策记录（无服务器、本机存储、中立立场、插件双轨制…） |

## 已知缺口

如实列出，不假装已完成：

- **第三方凭据**：Windows 上直接存进**系统凭据管理器**（`CredRead`/`CredWrite`/`CredDelete`/`CredEnumerate`，
  目标名 `gently:<pluginId>:<key>`），**重启后仍在**；macOS / Linux 的系统凭据库尚未接入，
  那两个平台会退回进程内存储，并在设置页的诊断卡片里显示「降级为进程内存储：重启后需要重新填写」
  （`system.status` 的 `credentialsBackend` 字段）。凭据永不进日志或数据库。
- **缺的是 Tauri 的 dialog 插件**（`tauri-plugin-dialog` 不在离线依赖缓存里）：插件导入因此提供
  「粘贴文本 / 网络地址 / 本机路径」三种来源，界面不给点了没用的「浏览…」按钮。
  **WebView 自己的文件选择器是可用的**——主题市场的「导入皮肤」走的就是它（打包版实测：
  点击后主窗口被模态对话框禁用，截出来正是系统的「打开」对话框）。
- **封面**：插件提供的封面（`artwork` 等字段）与**本地文件的内嵌封面**都已接入。
  本地封面在扫描时落进 `<data>/cache/covers/<hash>.<ext>`（文件名 = 源路径哈希），列表只多一个
  回环地址（`http://127.0.0.1:<port>/cover/<name>`，由媒体代理按字节回放），因此行里不会背上几十 KB；
  没有封面时照旧退回渐变。**已自动化覆盖**：mp3（ID3v2/APIC）与 FLAC（PICTURE 块）各有一个手写夹具
  端到端跑通；`.m4a/.ogg` 等同样走 symphonia 的元数据、逻辑一致但没有各自的夹具（如实记在契约 §4）。
- **MSI / NSIS 安装包需要联网**下载一次打包工具（见上）；离线可用的是便携版 zip。
- 视觉 / 交互正确性依赖人工走查（开发环境无法截图）。

## 许可

MIT（见 [`Cargo.toml`](Cargo.toml)）。
