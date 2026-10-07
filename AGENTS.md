# AGENTS.md — gently

> Agent 唯一入口。目标、阅读顺序、完成标准、红线。
> 详细规范见 `docs/`，本文件保持 <100 行。

## 1. 产品目标

`gently` 是一个 Tauri + React 19 + TypeScript + Vite 桌面音乐播放器。

- 形态：极简、数据密集、低动画；信息集中、传递高效。
- **不提供任何服务器**：无账号体系、无市场后端、无遥测（见 `docs/adr/0003-no-server-local-core.md`）。
  能力一律以**本机核心的 Tauri 命令/事件**提供；社区资源（插件/皮肤）靠用户自行 clone、
  下载或分享文件后**通用导入**。
- 当前阶段：**UI / 前端交付**，数据全部为 mock；音乐源以 **plugin** 形式接入
  （规划：内嵌 QuickJS 运行时 + 清单声明的权限白名单）。
- 技术栈锁定：React 19 / Vite 7 / TypeScript 5.8 / CSS Modules + 主题 token / Tailwind（仅限 `tw:` 前缀且视觉固定的组件）。

## 2. 目录阅读顺序

| 顺序 | 路径 | 作用 |
|---|---|---|
| 1 | `src/config/theme/theme.config.json` | **全部 UI 样式元数据**（颜色/尺寸/字体/圆角/动效/组件度量） |
| 2 | `src/theme/` | 把主题配置解析为 CSS 变量并注入 |
| 3 | `src/store/` | 集中式状态（切片 state + actions + selector hooks） |
| 4 | `src/services/` | 数据门面（曲库 / 本地库 / 窗口能力）——接入时只改这里 |
| 5 | `src/plugins/` | 音乐源插件契约与注册表 |
| 6 | `src/components/` | `layout` 布局容器、`ui` 通用组件、`shell` 应用外壳 |
| 7 | `src/views/` | 页面（含各自私有组件） |
| 8 | `docs/contracts/local-core-api.md` | **本机核心契约**：命令/事件清单、错误码、插件与皮肤模型 |
| 9 | `src/api/index.ts` | 上述契约的前端类型（只有类型，无实现） |
| 10 | `docs/ARCHITECTURE.md`、`docs/ROADMAP.md` | 架构与数据流；开发计划（M0–M5） |

## 3. 硬约束（改代码前必读）

1. **样式元数据唯一来源**是 `theme.config.json`（主题市场预设见 `presets.json`）。新增可见样式先加 token，再在 CSS Module 里 `var(--token)`。
2. **禁止在组件里硬编码**颜色、尺寸、圆角、时长；文案一律走 `src/i18n/locales/*.json`。
3. **Tailwind 仅用于「视觉稳定且不需要主题动态定制」的组件**，且必须带 `tw:` 前缀。其余用 CSS Module + token。
4. **组件化**：一个文件一个职责；视图私有组件放 `views/<page>/components/`，通用组件放 `components/ui/`。
5. **数据源只通过 `services/` 访问**；`views` / `store` 不得直接依赖具体 plugin 实现。
6. **业务列表的列定义**放 `src/config/table.config.tsx`，视图只做组合。
7. **列表行操作 / 行点击**统一走 `src/hooks/useTrackActions.ts`（点当前曲目 = 播放暂停，点其他 = 切歌）。
8. **两个主题入口职责不可合并**：灯泡 = 明暗背景，调色板 = 主题市场；设置只在右上角提供，不进侧边栏。
9. **歌曲信息只在播放条展示**：歌词页（`/now-playing`）只保留封面 + 歌词；收藏 / 下载 / 加入歌单等功能性操作放播放条的「功能抽屉」。
10. **进度条是播放条顶边的 SeekBar**：默认不显示焦点，悬浮 / 拖拽才显示；焦点皮肤由 `playerBar.progressThumbSkin` 配置。
11. **危险操作必须走 `useConfirm()`**（删除 / 清空 / 卸载类），不要直接调用 action；弹窗由 App 里的 `ConfirmHost` 统一渲染。
12. **不引入服务器依赖**：不加 HTTP 服务、账号体系、遥测上报、Docker/数据库服务；所有「后端」能力都必须是本机核心的 Tauri 命令或事件。
13. **契约只有一处**：规范在 `docs/contracts/local-core-api.md`，类型在 `src/api/index.ts`。新增命令先登记契约，再由 `src/services/**` 封装；**UI/store 不得直接 `invoke`**（与第 5 条同源）。
14. **社区资源按不可信代码对待**：插件安装必须 `plugin.preview` → 用户显式同意；不执行安装脚本；插件 JS 只在 QuickJS 沙箱内运行，网络限于清单 `hosts`；第三方凭据只进 OS keyring，日志与 SQLite 中不得出现明文。
15. **单一职责**：前端只做 UI 与渲染；数据处理与算法（聚合去重、推荐打分、持久化、播放解析）归本机核心。**同一算法只允许一份实现**——迁移时先搬后删，禁止长期双份。

## 4. 每类操作的完成标准

| 操作 | 完成标准 |
|---|---|
| 改 UI / 加视图 | `tsc --noEmit` 通过；文案有 zh+en；无硬编码样式；刷新页面人工确认 |
| 改样式 / 加 token | 同步更新 `theme.config.json` 与消费方 CSS；浅色 + 深色都可读 |
| 改状态 | 只改 `src/store/**`；视图通过 selector hooks 订阅，不新增组件内 state 副本 |
| 加音乐源 | 在 `src/plugins/` 新增实现并注册；不得改动 `services/catalog.service.ts` 的调用方 |
| 替换 mock | 只改 `src/services/**` 或 `src/mock/**`；UI 与 store 不动 |
| 加 / 改本机命令 | 先登记 `docs/contracts/local-core-api.md` 与 `src/api/index.ts`，再由 `services/` 封装；`pnpm typecheck && pnpm smoke` 通过 |
| 结构调整 | 同步更新 `docs/ARCHITECTURE.md` 与 `docs/STATE.md` |

## 5. 命令

```bash
pnpm typecheck   # tsc --noEmit（只读）
pnpm smoke       # 冒烟测试：状态层断言 + 全部组件可渲染 + i18n/CSS token 守卫（172 项）
pnpm dev         # 开发
pnpm build       # tsc && vite build
pnpm tauri dev   # 桌面端
```

改动状态层 / 主题 / 插件后，**必须**跑 `pnpm typecheck && pnpm smoke`。

## 6. 红线

- 不静默假设；不确定先问。
- 不做无关重构；不新增未要求的抽象或依赖。
- 不删除未接入的历史草案（已归档在 `docs/archive/`）。
- 不把 mock 数据写进组件；不留 `TODO` 代替实现。
- 不引入重量级依赖；引入前先确认是否能用现有工具解决。
- 改动 `theme.config.json` 的 token 名必须全仓搜索旧名，避免出现失效变量。
