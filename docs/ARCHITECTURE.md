---
status: active
last_verified: 2026-02-14
owner: gently
scope: 架构骨架、数据流、扩展点
token_budget: 2400
tldr: 四层结构（theme / store / services+plugins / components+views）；样式元数据集中在 theme.config.json；数据源以 plugin 接入；状态集中在单一 store。
---

# ARCHITECTURE

## 1. 分层与依赖方向

```
views/  components/          ← 只关心展示与用户意图
      ↓
store/                       ← 集中式状态（切片 state + actions）
      ↓
services/                    ← 数据门面（唯一数据入口）
      ↓
plugins/                     ← 音乐源插件契约 + 注册表 + 内置实现
      ↓
mock/                        ← 当前阶段的假数据（后续被插件替换）

config/theme + theme/        ← 横切：样式元数据 → CSS 变量
i18n/                        ← 横切：全部文案
types/ utils/                ← 横切：领域模型与纯函数
```

依赖方向单向向下；`views` 不直接 import `plugins` / `mock`。

## 2. 主题与样式元数据

**唯一来源**：`src/config/theme/theme.config.json`（基础上）+ `src/config/theme/presets.json`（主题市场预设）

```
theme.config.json          presets.json
   ├── palette                ├── palette（品牌色覆盖）
   ├── scheme.light|dark      ├── scheme.light|dark（可选覆盖）
   ├── typography             └── swatches（市场预览色块）
   ├── radius / spacing
   ├── shadow / motion
   ├── zIndex
   └── components         组件度量：titleBar / searchBox / toolbar / sidebar /
                          playerBar / view / section / dataTable / card / chart
        ↓  resolveTheme(config, presetId)      ← 预设叠加（只覆盖显式声明的字段）
        ↓  buildCssVars(config, scheme)
   CSS 变量（--title-bar-height、--search-box-radius、--table-row-hover-bg …）
        ↓  ThemeProvider / applyInitialTheme()
   <html style="--…"> + data-theme + data-preset + color-scheme
```

规则：

- CSS Module 只写 `var(--token)`，**不写字面量颜色/尺寸**。
- 需要新的可见样式 → 先在 `theme.config.json` 加字段，再在 `tokens.ts` 映射，再消费。
- 组件 token 支持 `{text.primary}` / `{brand.soft}` 形式的语义引用，由 `resolveTokenRef` 解析。
- 深浅色不写 `@media (prefers-color-scheme)`，由 provider 换 scheme 并重写变量。

### 两个入口，职责不重叠

| 入口 | 图标 | 作用 | 状态 |
|---|---|---|---|
| 明暗背景 | 灯泡 | light ⇄ dark 一键切换 | `ui.themeMode` |
| 主题市场 | 调色板 → `/theme` | 选择配色预设（品牌色 + 可选配色板） | `ui.themePresetId` |

`ui.themeMode` 与 `ui.themePresetId` 通过 `store/persist.ts` 落到 localStorage，
`applyInitialTheme()` 在 React 挂载前读取并注入，避免首屏闪烁。

### 动态背景与「玻璃化」外壳

`components/background` 把 `src/assets/bgc.mp4` 以 `object-fit: cover` 铺满整个视图，
并挂载时在 `<html>` 上打 `data-video-bg="on"`。外壳组件统一消费 `--surface-chrome`：

```css
:root { --surface-chrome: var(--bg-surface); }              /* 默认不透明 */
html[data-video-bg='on'] { --surface-chrome: var(--bg-surface-translucent); }
```

因此「是否开启动态背景」只是 token 切换，组件无需条件分支。
透明度 / 模糊 / 遮罩由 `components.background`（opacity / blurPx / scrim）配置，
并在 `prefers-reduced-motion: reduce` 下自动关闭视频。

## 3. 集中式状态

`src/store/`，零依赖，基于 React 18+ 的 `useSyncExternalStore`。

```
createStore<T>()                 顶层浅合并 + 浅比较通知
slices/ui.slice.ts               themeMode / themePresetId / scheme / collapsedGroups / searchQuery
slices/player.slice.ts           current / queue / playing / elapsed / duration / repeat / volume / lyrics
slices/ranking.slice.ts          chart / period / date / weekStart / expanded / rows / loading
slices/download.slice.ts         tasks / loaded（含 add 入队）
slices/plugin.slice.ts           list / loaded
slices/library.slice.ts          local / recent / query / loaded
slices/collection.slice.ts       favorites / playlists / loaded
index.ts                         组合 store、导出 useActions / useSelect / useXxxState
persist.ts                       themeMode + themePresetId 落 localStorage
```

约定：

- **切片只通过 `ctx.getActions()` 交互**，不互相 import。
- 组件用 selector 订阅最小切片；`actions` 对象引用恒定，无需订阅。
- 派生数据在 selector 或 `utils` 中计算；state 只存事实。
- 播放进度这类高频变更只让订阅它的组件（`PlayerBar` / 歌曲详情）重渲染；
  其他组件订阅派生字符串（如 `"title|artist"`、`current?.id`）而非整个 `player` 切片。
- 副作用（定时器 / 原生窗口 / 文件系统）隔离在 `src/hooks` 与 `src/services`。

### 列表交互的统一约定

`src/hooks/useTrackActions.ts` 是所有曲目列表的行操作与行点击的唯一来源：

- 行点击 → `player.playOrToggle(track, queue)`：**点当前曲目 = 播放/暂停，点其他曲目 = 切歌**；
- 行操作 → 播放 / 收藏（随收藏状态切换文案）/ 下载（可选）/ 视图特有的额外操作；
- `useCurrentTrackId()` 用于给正在播放的行加高亮（`DataTable.activeRowKey`）。

## 4. 数据源插件（音乐源）

```
plugins/types.ts        MusicSourcePlugin：info + fetchChart / fetchRecommend / search / resolveUrl
plugins/registry.ts     注册、查询、当前启用源
plugins/builtin/        mock-source.ts（内置示例源）
plugins/index.ts        副作用注册内置插件
```

- 任何数据源实现 `MusicSourcePlugin`，调用 `registerMusicSource` 即可接入；UI 无需改动。
- `services/catalog.service.ts` 是唯一调用方，并做榜单结果缓存。
- `PluginInfo`（元数据）与实现分离：插件管理页只消费元数据。

```
view → store.ranking.load() → services.catalogService.fetchChart()
     → plugins.getActiveMusicSource().fetchChart() → (mock | 真实源)
```

## 5. 组件分层

```
components/
  layout/   SplitLayout（泛型分割）+ TMBLayout / LMRLayout + axis 描述符
  ui/       page / data-table(+cells) / search-box / radio-group / button
            / empty-state / section-header / lyrics / icon
  shell/    background（动态背景）/
            title-bar（Logo + SearchBox + Toolbar）/
            sidebar /
            player-bar（SeekBar + 播放列表抽屉 + 功能抽屉）
views/
  <page>/index.tsx            页面
  <page>/components/*         该页面私有组件（如 ranking 的 HeroCard / ChartSection / DatePicker）
  download/{downloading,downloaded}/index.tsx   子路由页面
```

- 通用组件不含业务数据，数据与文案由调用方注入。
- 列表列定义集中在 `src/config/table.config.tsx`，视图只做组合。
- 视图统一用 `<Page>` 提供标题 / 副标题 / 工具条，保证间距规格一致。

### 路由与入口

| 路径 | 视图 | 入口 |
|---|---|---|
| `/ranking` `/hot` `/download/*` `/local` `/plugin` `/recent` | 主菜单页面 | 侧边栏主菜单（由路由 meta 派生） |
| `/favorites` | 我的收藏 | 侧边栏「我的收藏」 |
| `/playlist/:id` | 歌单详情 | 侧边栏歌单项 |
| `/search?q=` | 搜索结果 | 顶栏搜索提交（URL 即状态，可分享 / 刷新） |
| `/now-playing` | 歌词页（封面 + 歌词） | 播放条封面 / 曲名 |
| `/theme` | 主题市场 | 工具栏调色板按钮、设置页 |
| `/setting` | 设置 | **仅**工具栏齿轮（侧边栏不再重复提供） |

`hideInMenu: true` 的路由不会进入主菜单；冒烟测试对此有断言守护。

### 播放条结构（bottom）

```
┌─ SeekBar（贴顶边，bilibili 式：默认无焦点，悬浮放大并显示焦点；皮肤由
│   playerBar.progressThumbSkin = default | glow | ring 决定）───────────────┐
│  封面  标题 / 歌手·专辑 / 时长·来源   ♡ │ ⏮ ⏯ ⏭  elapsed/duration │ 循环 队列 功能 音量 │
└──────────────────────────────────────────────────────────────────────────┘
        ↑ 队列 / 功能抽屉从播放条上方展开（bottom: 100%）
```

- **歌曲信息**（封面 / 标题 / 歌手 / 专辑 / 时长 / 来源）随播放在播放条展示；
  歌词页因此只保留「封面 + 歌词」。
- **播放列表抽屉**展示当前曲目与队列，点击即切换（`player.queue` 状态）。
- **功能抽屉**收敛功能性操作：收藏 / 下载 / 加入歌单 / 打开歌词页。

### 音频播放链路

```
view → store.player.play(track)
     → 歌词：services.libraryService.loadLyrics(track)
     → 音源：services.catalogService.resolveUrl(track) → plugins（内置示例源返回
              src/assets/yihuik苡慧 - 致你.m4s，仅用于验证播放链路）
     → hooks/useAudioEngine：把 store 状态接到 services/audio.service.ts 的 <audio>
     → <audio> timeupdate → store.player.setProgress(elapsed, duration)
     → <audio> ended → store.player.next()
     → 音源不可用（播放失败 / 无地址）→ store.player.markUnplayable()
       → hooks/usePlayerEngine 接管，用模拟时钟推进进度
```

`player.playable` 是唯一开关：有真实音源时进度由音频引擎回写，没有时用回退时钟，
UI 无需关心差别。

## 6. i18n

`src/i18n/locales/{zh,en}.json`，命名空间：
`app / nav / common / search / toolbar / sidebar / player / column / page.<页面>`。
组件内不出现中文字面量。

## 7. 与 Tauri 的边界

- `services/window.service.ts` 封装最小化 / 最大化 / 关闭 / 置顶 / 小窗；
  浏览器环境为安全空操作，仅在 Tauri 宿主动态 `import('@tauri-apps/api/window')`。
- 后续本地文件、下载落盘等能力同样从 `services/` 进入，视图不直接调用 Tauri API。

## 8. 遗留与归档

`docs/archive/` 保存未接入产品的早期实现，**不参与构建**：

- `core-draft/`：可视化编辑器的 AOP / modifier / registry 草案（缺类型定义，未接入）。
- `legacy-ui/`：旧版组件目录（table / input / radiobtn / icons / logo / tool / Sidebar / Player / card / section）。
- `legacy-views/`：旧版 `*_view` 页面目录（含未完成的 ranking_view 占位实现）。

归档原因：目录树按单一职责重组，旧实现已被 `components/{ui,shell}` 与 `views/<page>` 取代。
如需恢复，直接 `Move-Item` 回 `src/` 并修正引用即可。
