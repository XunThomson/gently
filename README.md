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
  播放按各源声明的音质降级；榜单/收藏曲目失败时可在播放条点「换源」按歌名歌手重新找源，
  不会在失败时自动打满所有音源。
- **本地视频 / 静态网页背景**：可导入 mp4 / webm / m4v，或单文件静态 HTML/CSS；背景铺满整窗，
  可调整填充方式、速度、不透明度、虚化、**内容透明度 / 内容虚化**（只改卡片/外壳背景，
  文字不透明也不模糊），并保存/重命名/导出命名预设；
  支持粘贴外部壁纸工具的 Share JSON（只映射已知展示参数）。
  系统开启「减少动态效果」时默认不播放，可在设置里显式选择「仍然播放」。
  窗口失焦时视频**暂停而不是消失**，回到窗口继续播放。
  网页壁纸在 `sandbox` + CSP 里渲染，脚本、外链、表单都不执行；不解析 `.pkg` 专有格式，
  不做带 JS / 多文件的网页壁纸。
- **壁纸准备助手**：选择静态网页目录后，把本机 CSS/图片内联成单个 HTML（脚本、外部资源、
  `@import` 会被移除），可直接设为背景或下载；Scene 只接受用户导出/录屏的视频，不解析 `.pkg`。
- **宠物（Beta 1.0）**：独立引擎 `pet-core` + 独立库 + **独立置顶小窗**（主窗口最小化它也在）。
  会看向鼠标、透明处点击穿透、左键摸摸、右键喂食，好感/饥饿跨会话保存；可导入我们自己的宠物包
  或社区 Codex Pet 的包（v1/v2）。默认关闭，见 [`docs/pet.md`](docs/pet.md)。

## 结构

```
core/         Rust 本机核心（不依赖 tauri，可独立 cargo test）
pet-core/     宠物核心引擎（独立 crate：自己的库文件、不依赖音乐核心与 UI，见 ADR 0010）
src-tauri/    薄适配层：把核心能力暴露成一条 Tauri 命令 + 事件
src/          React 前端（views / store / services / components / theme / i18n）
docs/         契约、架构、路线图、ADR、STATE（当前迭代状态）
scripts/      契约守卫、冒烟测试、交付前验证、打包
```

数据流方向固定为：`views → store → services → (Tauri 命令) → core`。
UI 与 store **不得**直接 `invoke`，也不直接依赖某个具体插件。
宠物是**第二个引擎**：`pet-core` 与 `core` 互不依赖，各自被宿主消费（ADR 0010）。

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
| `pnpm smoke` | 冒烟测试：状态层断言 + 全部组件可渲染 + i18n / CSS token / 契约守卫（509 项；含 **2.x 宠物接口** 6 项、**第三方授权** 9 项、**源收藏** 8 项与**缓存上限** 2 项——宿主空态 / 同 id 覆盖 / 旧注销不误删 / 只读快照 / 授权四条命令与参数 / 授权地址交给系统浏览器 / `auth:changed` 刷新状态；末尾用**假宿主**把「核心优先读 / 核心在时不退回 mock / 下载被拒 / 下载设置与并发 / 歌词搜索 / 缓存管理 / 桌面歌词载荷 / 皮肤裁决」等桌面端分支也跑一遍） |
| `pnpm check:contract` | 契约守卫：文档 ↔ Rust 命令/事件清单 ↔ 前端服务层与事件常量（含事件名字符集，双向） |
| `pnpm check:pet` | 宠物域守卫：`pet-core` 独立性（无 `gently-core` / 无 tauri / 无仓内相对依赖）+ 契约表 ↔ 清单 |`n| `pnpm check:reachability` | 界面可达性守卫：每条契约能力是否**真的能从界面走到**（有实现有封装、却没人调用 → 失败；白名单要写理由） |
| `pnpm verify` | 交付前一次跑完**八道关卡**：typecheck + smoke + check:contract + check:reachability + `cargo test -p gently-core` + `check:pet` + `cargo test -p pet-core` + `cargo test -p gently`（宿主单测） |
| `pnpm build` | `tsc && vite build`（只构建前端） |
| `pnpm ui:capture` | （仅 Windows）截屏/驱动打包版做视觉走查：`pnpm ui:capture -- -Launch -AssertRendered -Output release/screenshots/boot.png -Kill` |
| `scripts/pet-window.ps1` | （仅 Windows）驱动**宠物窗口**：`-Drag` 注入鼠标拖动、`-Walk` 等它自己走起来连拍、随时截图 |
| `pnpm package:portable` | **离线可用的分发产物**：便携版 zip（输出在 `release/`） |
| `pnpm tauri build` | 出 MSI / NSIS 安装包（首次需要联网取打包工具，见下） |
| `cargo test -p gently-core` | 核心单测（不依赖 tauri，秒级） |

### 离线构建约定

crate 缓存只放一处（由 `CARGO_HOME` 指向的那份 registry）；把 `CARGO_HOME` 设到它，
`pnpm verify` 就会默认给 cargo 加 `--offline`。需要联网拉依赖时用
`GENTLY_CARGO_ONLINE=1 pnpm verify`。仓库不记录本机路径，缓存放哪儿由各自的 shell 环境变量决定。

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
| [`docs/contracts/pet-core-api.md`](docs/contracts/pet-core-api.md) | **宠物核心契约**（独立命名空间 `pet.*`）：信封、错误码、命令表 |
| [`docs/pet.md`](docs/pet.md) | **宠物（Beta 1.0）使用说明**：开关、交互、窗口/穿透、导入社区包、数据位置、已知边界 |
| [`docs/pet-package.md`](docs/pet-package.md) | **宠物包规范**：`pet.json` + 图集约定、行为表能写什么、校验规则 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 分层、数据流、播放链路、i18n、契约边界 |
| [`docs/STATE.md`](docs/STATE.md) | 当前迭代状态：本轮做了什么、验证结果、下一步 |
| [`docs/GOTCHAS.md`](docs/GOTCHAS.md) | 非显然的坑与规避方式（现象 → 根因 → 验证） |
| [`docs/DESIGN-REUSE.md`](docs/DESIGN-REUSE.md) | 可沿用的概念与设计（做安卓 / pet-core 前先读） |
| [`docs/ANDROID-INFRA-ASSESSMENT.md`](docs/ANDROID-INFRA-ASSESSMENT.md) | 安卓端适配的**基础设施评估**：缺什么、按什么顺序做、怎么验收 |
| [`docs/archive/rounds/`](docs/archive/rounds/) | 历史轮次的完整过程与证据（默认不读） |
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





