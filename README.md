# gently

一个**不依赖任何服务器**的桌面音乐播放器：Tauri（Rust 本机核心）+ React 19 + TypeScript。

- **无账号、无市场后端、无遥测**：所有能力都是本机核心的 Tauri 命令与事件
  （[ADR 0003](docs/adr/0003-no-server-local-core.md)）。
- **对第三方资源保持中立**：不内置、不推荐、不预置任何音源或资源入口；插件与皮肤由用户
  自行获取后**通用导入**（[ADR 0005](docs/adr/0005-neutral-third-party.md)）。用户动作之前不发起外部请求。
- **音乐源以插件接入**：内嵌 QuickJS 沙箱、清单声明权限与域名白名单；安装先预览、再由用户决定。
  兼容 MusicFree / LX 生态的 CommonJS 插件（[双轨制](docs/adr/0006-plugin-format-dual-track.md)）。
  播放按各源声明的音质降级；失败时可在播放条点「换源」，不会自动打满所有音源。
- **背景**：本地视频 / 图片 / 单文件静态网页；可调填充、位置、缩放、透明度与虚化，
  支持命名预设。网页壁纸在 sandbox + CSP 中渲染，脚本、外链与表单不执行。
- **宠物（Beta 1.0）**：独立引擎 `pet-core`、独立数据库、独立置顶小窗；会看向鼠标、
  透明处点击穿透、左键摸摸、右键喂食，好感 / 饥饿跨会话保存。默认关闭，见 [docs/pet.md](docs/pet.md)。

## 结构

```
core/         Rust 本机核心（不依赖 tauri，可独立 cargo test）
pet-core/     宠物核心引擎（独立 crate，不依赖音乐核心与 UI，见 ADR 0010）
src-tauri/    薄适配层：把核心能力暴露成 Tauri 命令 + 事件
src/          React 前端（views / store / services / components / theme / i18n）
docs/         契约、架构、路线图、ADR、STATE
scripts/      契约守卫、冒烟测试、交付前验证、打包
```

数据流固定为 `views → store → services →（Tauri 命令）→ core`。
UI 与 store 不直接 `invoke`，也不依赖具体插件实现。

## 快速开始

```bash
pnpm install
pnpm dev           # 浏览器预览：无本机核心，数据来自 src/mock，只用于看界面
pnpm tauri dev     # 桌面端：真实核心 + SQLite + 插件沙箱
```

浏览器预览是开发态兜底，不是产品形态；真实数据、持久化与插件都在桌面端。

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm smoke` | 冒烟测试：状态层、全部组件可渲染、i18n / CSS token 守卫、假宿主下的桌面端分支 |
| `pnpm check:contract` | 契约守卫：文档 ↔ Rust 命令/事件清单 ↔ 前端服务层与事件常量（双向） |
| `pnpm check:reachability` | 界面可达性：每条契约能力是否真能从界面走到 |
| `pnpm check:pet` | 宠物域：`pet-core` 独立性 + 契约表 ↔ 清单 |
| `pnpm verify` | 一次跑完：typecheck + smoke + 契约 + 可达性 + cargo test（两个 core + 宿主）+ check:pet |
| `pnpm build` | `tsc && vite build`（只构建前端） |
| `pnpm ui:capture -- -Launch -AssertRendered -Output release/screenshots/boot.png -Kill` | （仅 Windows）截屏 / 驱动打包版做视觉走查 |
| `node scripts/android-cdp.mjs ping\|eval\|tap\|shot\|net` | 真机 WebView 的 CDP 驱动（debug 包） |
| `pwsh -File scripts/pet-window.ps1 -Drag -Output release/screenshots/pet.png` | （仅 Windows）驱动宠物窗口：拖动 / 走动 / 截图 |
| `pnpm package:portable` | 离线可用的便携版 zip（输出在 `release/`） |
| `pnpm tauri build` | MSI / NSIS 安装包（首次需要联网取打包工具） |

离线构建：crate 缓存只放一处，由 `CARGO_HOME` 指向；设好后 `pnpm verify` 默认给 cargo
加 `--offline`，需要联网时用 `GENTLY_CARGO_ONLINE=1 pnpm verify`。仓库不记录本机路径。

## 文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | 协作入口：硬约束、完成标准、红线（改代码前先读） |
| [docs/contracts/local-core-api.md](docs/contracts/local-core-api.md) | 本机核心契约：命令 / 事件 / 错误码 / 插件与皮肤模型 |
| [docs/contracts/pet-core-api.md](docs/contracts/pet-core-api.md) | 宠物核心契约（独立命名空间 `pet.*`） |
| [docs/pet.md](docs/pet.md) / [docs/pet-package.md](docs/pet-package.md) | 宠物使用说明 / 宠物包规范 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 分层、数据流、播放链路、i18n、契约边界 |
| [docs/STATE.md](docs/STATE.md) | 当前迭代状态、验证结果、下一步 |
| [docs/GOTCHAS.md](docs/GOTCHAS.md) | 已经踩过、从代码看不出来的坑 |
| [docs/ROADMAP.md](docs/ROADMAP.md) / [docs/ANDROID-PLAN.md](docs/ANDROID-PLAN.md) | 里程碑 / 安卓执行计划 |
| [docs/adr/](docs/adr/) / [docs/archive/rounds/](docs/archive/rounds/) | 架构决策 / 历史轮次（默认不读） |

## 已知缺口

- **第三方凭据**：Windows 存进系统凭据管理器（`gently:<pluginId>:<key>`），重启后仍在；
  macOS / Linux 尚未接入系统凭据库，会退回进程内存储，并在诊断卡片里如实显示
  `system.status.credentialsBackend`。日志与数据库不出现明文。
- **文件选择器**：Tauri 的 dialog 插件不在离线依赖缓存里；插件导入因此提供
  「粘贴文本 / 网络地址 / 本机路径」三种来源。WebView 自身的文件选择器可用
  （主题市场导入皮肤走的就是它）。
- **封面**：插件封面与本地文件内嵌封面都已接入；本地封面落在
  `<data>/cache/covers/<hash>.<ext>`，由回环代理按字节回放。没有封面时退回渐变。
- **安装包**：MSI / NSIS 首次需要联网下载 WiX / NSIS；离线可用的是便携版 zip。
- **视觉 / 交互**：依赖 `ui:capture` 与真机 CDP 走查，不把「没运行」说成「通过」。

## 许可

MIT（见 [Cargo.toml](Cargo.toml)）。
