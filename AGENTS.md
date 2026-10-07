# AGENTS.md — gently

> Agent 唯一入口。目标、阅读顺序、完成标准、红线。
> 详细规范见 `docs/`，本文件保持 <100 行。

## 1. 产品目标

`gently` 是一个 Tauri + React 19 + TypeScript + Vite 桌面音乐播放器。

- 形态：极简、数据密集、低动画；信息集中、传递高效。
- 当前阶段：**UI / 前端交付**，数据全部为 mock；后续音乐源以 **plugin** 形式接入。
- 技术栈锁定：React 19 / Vite 7 / TypeScript 5.8 / CSS Modules + 主题 token / Tailwind（仅限 `tw:` 前缀且视觉固定的组件）。

## 2. 目录阅读顺序

| 顺序 | 路径 | 作用 |
|---|---|---|
| 1 | `src/config/theme/theme.config.json` | **全部 UI 样式元数据**（颜色/尺寸/字体/圆角/动效/组件度量） |
| 2 | `src/theme/` | 把主题配置解析为 CSS 变量并注入 |
| 3 | `src/store/` | 集中式状态（切片 state + actions + selector hooks） |
| 4 | `src/services/` | 数据门面（曲库 / 本地库 / 窗口能力） |
| 5 | `src/plugins/` | 音乐源插件契约与注册表 |
| 6 | `src/components/` | `layout` 布局容器、`ui` 通用组件、`shell` 应用外壳 |
| 7 | `src/views/` | 页面（含各自私有组件） |
| 8 | `docs/ARCHITECTURE.md` | 架构与数据流 |
| 9 | `server/` | 后端骨架（契约 + 基础设施；业务未实现，见 `server/README.md`） |

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
12. **后端接口只写在 `src/api/`（契约）与 `docs/contracts/`（规范）**，禁止在 UI/store 里直连 HTTP；替换点只有 `src/services/**`。
13. **后端骨架（`server/`）里新增接口必须先在 `server/src/contracts/endpoints.ts` 登记**（id/method/path/tag/auth/idempotent），路由文件的 `operationId` 与清单 id 一致；未实现业务一律挂 `notImplementedHandler`（501），不要返回 404 占位。
14. **后端不手写状态码**：业务抛 `ApiError`，状态码由 `server/src/contracts/primitives.ts` 的 `ERROR_STATUS` 决定；`server/src/infra/**` 不得依赖 fastify 的请求/响应对象。

## 4. 每类操作的完成标准

| 操作 | 完成标准 |
|---|---|
| 改 UI / 加视图 | `tsc --noEmit` 通过；文案有 zh+en；无硬编码样式；刷新页面人工确认 |
| 改样式 / 加 token | 同步更新 `theme.config.json` 与消费方 CSS；浅色 + 深色都可读 |
| 改状态 | 只改 `src/store/**`；视图通过 selector hooks 订阅，不新增组件内 state 副本 |
| 加音乐源 | 在 `src/plugins/` 新增实现并注册；不得改动 `services/catalog.service.ts` 的调用方 |
| 替换 mock | 只改 `src/services/**` 或 `src/mock/**`；UI 与 store 不动 |
| 加 / 改后端接口 | 先在 `server/src/contracts/endpoints.ts` 登记，再写路由 schema 与处理器；`pnpm --filter @gently/server typecheck && pnpm --filter @gently/server test` 通过 |
| 结构调整 | 同步更新 `docs/ARCHITECTURE.md` 与 `docs/STATE.md` |

## 5. 命令

```bash
pnpm typecheck   # tsc --noEmit（只读）
pnpm smoke       # 冒烟测试：状态层断言 + 全部组件可渲染 + i18n/CSS token 守卫（172 项）
pnpm dev         # 开发
pnpm build       # tsc && vite build
pnpm tauri dev   # 桌面端

# 后端骨架（server/，独立子包）
pnpm --filter @gently/server dev         # 启动（默认 127.0.0.1:8787，/docs 看 OpenAPI）
pnpm --filter @gently/server typecheck   # tsc --noEmit
pnpm --filter @gently/server test        # vitest：清单完整性/鉴权/501/幂等/错误映射
```

改动状态层 / 主题 / 插件后，**必须**跑 `pnpm typecheck && pnpm smoke`。

## 6. 红线

- 不静默假设；不确定先问。
- 不做无关重构；不新增未要求的抽象或依赖。
- 不删除未接入的历史草案（已归档在 `docs/archive/`）。
- 不把 mock 数据写进组件；不留 `TODO` 代替实现。
- 不引入重量级依赖；引入前先确认是否能用现有工具解决。
- 改动 `theme.config.json` 的 token 名必须全仓搜索旧名，避免出现失效变量。
