---
status: active
last_verified: 2026-02-14
owner: gently
scope: 当前迭代状态与下一步
token_budget: 700
tldr: UI/前端交付完成：主题 token 体系、集中式 store、plugin 数据源骨架、七个视图全部落地；tsc / smoke(59) / vite build 三项验证全绿。下一步：接入真实音乐源插件与本地持久化。
---

# STATE

## 当前迭代目标

完成 UI / 前端交付（mock 数据），并完成结构、命名、状态管理的治理。

## 已完成

- **主题体系**：`src/config/theme/theme.config.json` 是全部样式元数据唯一来源（配色 / 字体 /
  间距 / 圆角 / 阴影 / 动效 / 层级 / 10 个组件度量）；`src/theme/`（types / tokens / ThemeProvider）
  解析为 CSS 变量注入 `<html>`，支持 light / dark / system，挂载前同步注入避免闪烁，
  组件 token 支持 `{text.primary}` 语义引用。
- **集中式状态**：`src/store/`（零依赖，基于 `useSyncExternalStore`），
  切片 ui / player / ranking / download / plugin / library；selector hooks + 引用稳定的 actions；
  异步 action 返回 Promise 可等待；榜单请求带同键 in-flight 去重；高频进度只让 PlayerBar 重渲染。
- **数据源插件骨架**：`src/plugins/`（契约 + 注册表 + 内置 mock 源）+
  `src/services/` 门面（catalog / library / file / window）；视图不感知具体实现，替换数据源只改 services。
- **视图全部落地**：ranking（今日推荐 + 榜单 4×4 + 日期/周选择 + 展开）、
  hot（推荐 + 全局搜索结果）、download（下载中 / 已下载子路由，Tab 由 URL 推导，无重定向闪烁）、
  local（含「在文件夹中显示」）、plugin（启停/更新/卸载，内置不可卸载）、recent（含清空记录）、
  setting（主题模式 / 语言 / 数据源 / 版本）。
- **外壳**：title-bar（Logo + 全局搜索 + 工具栏，含主题循环与原生窗口控制）、
  sidebar（选中态由 URL 派生，分组折叠入 store）、player-bar（进度 / 音量 / 循环模式）。
- **结构治理**：`components/{layout,ui,shell}` 三分 + `views/<page>[/components]`；
  63 个旧文件（含 `core` 草案与全部 `*_view`）已 `Move-Item` 到 `docs/archive/`，未删除任何内容。
- **CSS 迁移遗留修复**：失效变量（`--text-3`/`--surface`/`--border-2`/`--accent` …）统一为 token 命名；
  snake_case 类名（`.select_tab`/`.list_container`）清除；无效字重（680/550）修正；
  `global.css` 只保留 reset/base，原子层收敛到 `utilities.css`；Tailwind 保留 `tw:` 前缀但零使用。
- **去重**：图标集合并为单一 `ui/icon`；`UnderlineRadioGroup` 去掉 tailwind 类改用 token；
  搜索结果/榜单行到 `Track` 的转换集中在 `utils/track.ts`；列定义集中在 `config/table.config.tsx`。
- **i18n**：zh / en 全量键（app/nav/common/search/toolbar/sidebar/player/column/page.*），
  组件内无中文字面量，并由冒烟测试守护「键集合一致」与「无死键」。
- **工程化**：`AGENTS.md`、`docs/ARCHITECTURE.md`、本文件；
  新增 `pnpm typecheck`、`pnpm smoke`（`scripts/smoke.tsx` + `scripts/run-smoke.mjs`）。

## 验证结果

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | 通过（0 error） |
| 冒烟测试 | `pnpm smoke` | 59/59 通过（i18n / 主题 / 插件 / services / 6 个状态切片 / 12 个组件渲染） |
| 生产构建 | `pnpm build` | 通过，246 modules，主包 434 KB（gzip 141 KB） |

## 下一步

1. 真实音乐源插件：新增 `src/plugins/<source>/` 并注册，无需改视图与 services 调用方。
2. 本地曲库 / 下载落盘切到 Tauri fs + 持久化（只改 `services/library.service.ts`）。
3. 侧边栏「我的歌单 / 我的收藏」接入真实数据（当前为空态占位）。
4. 浏览器端人工走查浅色 / 深色两套配色（沙箱内无法截图验证）。
5. `src-tauri` 侧跑一次 `pnpm tauri build`，确认新增的 window 权限标识符全部有效。

## 阻塞 / 风险

- 无版本控制：该目录不是 git 仓库，故历史实现一律归档而非删除；建议尽快 `git init` 并首次提交。
- `services/{window,file}.service.ts` 的原生能力仅在 Tauri 宿主内生效，浏览器 dev 下为安全空操作；
  Tauri 权限已在 `src-tauri/capabilities/default.json` 补齐（window: minimize / toggle-maximize /
  close / set-always-on-top / set-size），但**尚未在 Tauri 侧编译验证**。
- 浏览器端尚无自动化 UI 截图回归，视觉正确性依赖人工确认。
