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

**三个配置文件的唯一分工**（索引见 `src/config/README.md`）：

| 文件 | 内容 | 生效时机 |
|---|---|---|
| `src/config/theme/theme.config.json` | 全部**样式元数据**：palette / scheme / typography / radius / spacing / shadow / motion / zIndex + 18 个组件组度量 | 运行时（注入 CSS 变量） |
| `src/config/theme/presets.json` | 主题市场预设：可覆盖 palette / scheme / **components**（密度与布局） | 运行时（切换预设立即生效） |
| `src/config/app.config.ts` | **行为与规模**：窗口、播放器步长、列表条数、下载引擎、mock 规模与延迟 | 构建期 |

```
theme.config.json          presets.json                app.config.ts
   ├── palette                ├── palette（覆盖）           ├── window
   ├── scheme.light|dark      ├── scheme（覆盖）            ├── player（步长/阈值）
   ├── typography             ├── components（密度覆盖）    ├── list（条数上限）
   ├── radius / spacing       └── swatches（预览色块）      ├── download / lyrics
   ├── shadow / motion                                     ├── mock（数据规模）
   ├── zIndex                                              └── latency
   └── components（18 组）
        ↓  resolveTheme(config, presetId)      ← 按组浅合并，未声明字段继承
        ↓  buildCssVars(config, scheme)
   CSS 变量（--table-row-min-height、--lyrics-active-font-size、--player-progress-thumb-size …）
        ↓  ThemeProvider / applyInitialTheme()
   <html style="--…"> + data-theme + data-preset + color-scheme
```

规则：

- CSS Module 只写 `var(--token)`，**不写字面量颜色/尺寸**。
- 需要新的可见样式 → 先在 `theme.config.json` 加字段，再在 `tokens.ts` 映射，再消费（步骤见 `src/config/README.md`）。
- 组件 token 支持 `{text.primary}` / `{brand.soft}` / `{status.danger}` / `{scrim}` 形式的语义引用，由 `resolveTokenRef` 解析。
- 深浅色不写 `@media (prefers-color-scheme)`，由 provider 换 scheme 并重写变量。
- **外壳读取解析后的主题**（`useTheme().config`），因此密度预设能改变标题栏 / 侧边栏 / 播放条尺寸。

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

## 4. 数据源插件（音乐源）与多音源

```
plugins/types.ts        MusicSourcePlugin：info + qualities + fetchChart / fetchRecommend /
                        search / resolveUrl(track, quality) → ResolvedSource | null
plugins/registry.ts     注册、启用状态（唯一来源）、音源元数据、按 id 取插件
plugins/builtin/
  source-factory.ts     用内置数据造一个「行为真实」的模拟源（可设不可播比例 / 延迟）
  mock-source.ts        内置示例源：始终可播，作为自动回退兜底
  alternate-sources.ts  Bilibili（约 1/4 不可播）、网易云（约 1/3 不可播）
plugins/index.ts        副作用注册全部内置插件
```

### 要解决的问题

同一首歌在多个音源下都有条目。如果直接平铺展示：**同一个内容出现多次**；
而如果随便挑一个源播放：**该源的这一首可能播不了**。

### 解决方式：聚合展示 + 播放期回退 + 可选分源

```
              ┌── 聚合（aggregate，默认）
视图数据 ─────┤   groupTracks(所有启用源的结果)
              │     → 一首歌一条（GroupedTrack），多音源进入 candidates
              └── 分源（perSource）
                 只请求选中的音源，返回原始条目
                          ↑
        页面音源筛选 SourceFilter（tabs / drawer，样式在设置里选）
```

```
点击播放 → player.start(track)
  candidates = track.candidates（聚合结果）或 [单候选]
  按「优先音源」排序 → 依次 catalogService.resolveUrl(candidate.track, 期望音质, candidate.source)
     ├── 返回 ResolvedSource → 可播放：写入 audioUrl / activeSource / quality
     └── 返回 null（该源此曲不可播）→ 记入 failedSources，继续下一个候选
  全部失败 → 退回模拟时钟（进度照常推进，UI 不卡死）
```

- 音质：`utils/quality.pickQuality(源支持的档位, 期望档位)` —— 期望档位不可用时**按源能力降级**，
  实际在播档位显示在播放条上。
- 手动切换：播放条的音源选择器可指定某个候选源（只试该源），失败的源在列表里标记「不可用」。
- 启用/停用：插件管理页的开关会写入注册表，**注册表才是「哪些源参与聚合与回退」的唯一来源**。

### UI 入口

| 位置 | 作用 |
|---|---|
| 播放条「音源」选择器 | 当前在播音源 + 自动回退提示 + 手动切换（含不可用标记） |
| 播放条「音质」选择器 | 当前在播档位 + 选择优先档位（不支持的档位置灰） |
| 页面音源筛选 `SourceFilter` | 排行榜 / 热门推荐 / 搜索结果：「全部音源」或指定源 |
| 设置 → 音源与音质 | 列表展示方式（聚合 / 分源）、筛选样式（横向标签 / 列表抽屉）、优先音源、优先音质 |


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
`app / nav / common / search / toolbar / sidebar / player / column / quality / source /
recommend / confirm / skin / page.<页面>`。
组件内不出现中文字面量；冒烟测试校验「键集合一致」与「无死键」。

## 7. 个性化推荐

```
用户行为（最近播放 + 收藏）
   ↓ utils/recommend.buildTasteProfile
口味画像：标签权重 + 歌手权重（播放次数取对数、12h 半衰期衰减、收藏加权）
   ↓ rankTracks / rankAlbums / rankPlaylists
候选池（内置曲库 / 专辑 / 精选歌单）按命中强度排序
   ↓ explain()
可解释推荐理由：artist（因为你听过 X）/ tag（因为你喜欢某标签）/ trending（回落）
   ↓ services/recommend.service → store.recommend 切片
推荐页三个区块：单曲 / 专辑 / 歌单，每条都带 ReasonChip
```

- 纯计算在 `src/utils/recommend.ts`（可测试），数据编排在 `services/recommend.service.ts`；
- 接入后端后换成 `api.recommend.home()`，本地打分逻辑保留为离线兜底；
- 候选池：专辑由内置曲库按歌手归集，精选歌单带风格标签（`src/mock/catalog.mock.ts`）。

## 8. 防误操作：二次确认

```
组件 → useConfirm()({titleKey, descKey, descParams, tone, onConfirm})
   ├── ui.confirmDestructive === true（默认）→ dialog 切片挂起请求
   │      → ConfirmHost 渲染 ConfirmDialog（Esc 取消 / Enter 确认 / 聚焦取消按钮 / Tab 环）
   │      → resolveConfirm() 执行 onConfirm
   └── false → 直接执行 onConfirm（用户显式关闭了提示）
```

已接入：删除歌单（侧边栏 / 歌单页）、卸载音源插件、清空播放列表、清空播放记录、
清理已完成下载、移除本地音乐、移除下载任务、删除皮肤。

## 9. 后端接口契约

只定义规范，不含实现：`src/api/types.ts`（传输原语）+ `src/api/contract.ts`（8 个域的能力接口），
规范正文见 `docs/contracts/backend-api.md`。

```
ApiResult<T>（不抛异常） / 游标分页 Page<T> / 幂等写（Idempotency-Key）
GentlyApi = { auth, catalog, library, recommend, playback, plugin, download, skin }
```

接入时只替换 `src/services/**` 内部的调用，UI 与 store 不变（映射表见规范文档第 8 节）。

## 10. 主题皮肤（复杂定制）

皮肤 = `presets.json` 的一个条目，可覆盖**任意令牌组**
（palette / scheme / typography / radius / spacing / shadow / motion / zIndex / components），
未声明的字段继承 `theme.config.json`：

- 内置 11 套：配色类（暮光紫 / 深海蓝 / 青柠 / 樱花 / 暖阳 / 石墨）、
  密度类（紧凑 / 宽适）、复杂类（圆润 = 大圆角 + 柔和阴影 + 慢动效；
  锐利 = 小圆角 + 无阴影 + 快动效；高对比 = 更强边框字重 + 更大字号）；
- 用户导入：主题市场「导入皮肤」读取 JSON → `parseSkin` 结构校验 → `installSkin`（立即应用并持久化）；
  「导出当前皮肤」生成可分享 JSON；自定义皮肤可删除（走二次确认）；
- 导入只做结构校验、不执行任何代码；解析失败给出具体原因。

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
