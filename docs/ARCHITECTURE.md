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

**唯一来源**：`src/config/theme/theme.config.json`

```
theme.config.json
   ├── palette            品牌色 / 状态色
   ├── scheme.light|dark  语义色板（背景、文字、边框…）
   ├── typography         字体族 / 字号 / 行高 / 字重
   ├── radius / spacing   圆角 / 间距刻度
   ├── shadow / motion    阴影 / 动效
   ├── zIndex             层级
   └── components         组件度量：titleBar / searchBox / toolbar / sidebar /
                          playerBar / view / section / dataTable / card / chart
        ↓  buildCssVars(config, scheme)
   CSS 变量（--title-bar-height、--search-box-radius、--table-row-hover-bg …）
        ↓  ThemeProvider / applyInitialTheme()
   <html style="--…"> + data-theme + color-scheme
```

规则：

- CSS Module 只写 `var(--token)`，**不写字面量颜色/尺寸**。
- 需要新的可见样式 → 先在 `theme.config.json` 加字段，再在 `tokens.ts` 映射，再消费。
- 组件 token 支持 `{text.primary}` / `{brand.soft}` 形式的语义引用，由 `resolveTokenRef` 解析。
- 深浅色不写 `@media (prefers-color-scheme)`，由 provider 换 scheme 并重写变量。

## 3. 集中式状态

`src/store/`，零依赖，基于 React 18+ 的 `useSyncExternalStore`。

```
createStore<T>()                 顶层浅合并 + 浅比较通知
slices/ui.slice.ts               themeMode / scheme / collapsedGroups / searchQuery
slices/player.slice.ts           current / queue / playing / elapsed / duration / repeat / volume
slices/ranking.slice.ts          chart / period / date / weekStart / expanded / rows / loading
slices/download.slice.ts         tasks / loaded
slices/plugin.slice.ts           list / loaded
slices/library.slice.ts          local / recent / query / loaded
index.ts                         组合 store、导出 useActions / useSelect / useXxxState
```

约定：

- **切片只通过 `ctx.getActions()` 交互**，不互相 import。
- 组件用 selector 订阅最小切片；`actions` 对象引用恒定，无需订阅。
- 派生数据在 selector 或 `utils` 中计算；state 只存事实。
- 播放进度这类高频变更只让订阅它的组件（`PlayerBar`）重渲染；
  其他组件订阅派生字符串（如 `"title|artist"`）而非整个 `player` 切片。
- 副作用（定时器 / 原生窗口）隔离在 `src/hooks` 与 `src/services`。

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
            / empty-state / section-header / icon
  shell/    title-bar（Logo + SearchBox + Toolbar）/ sidebar / player-bar
views/
  <page>/index.tsx            页面
  <page>/components/*         该页面私有组件（如 ranking 的 HeroCard / ChartSection）
  download/{downloading,downloaded}/index.tsx   子路由页面
```

- 通用组件不含业务数据，数据与文案由调用方注入。
- 列表列定义集中在 `src/config/table.config.tsx`，视图只做组合。
- 视图统一用 `<Page>` 提供标题 / 副标题 / 工具条，保证间距规格一致。

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
