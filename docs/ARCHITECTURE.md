---
status: active
last_verified: 2026-10-07
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
mock/                        ← **只在浏览器预览（无 Tauri 宿主）时**兜底；桌面端一律以核心为准

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
plugins/types.ts        MusicSourcePlugin：info + qualities + fetchTopLists / fetchTopList / fetchRecommend /
                        search / resolveUrl(track, quality) → ResolvedSource | null
plugins/registry.ts     注册、启用状态（唯一来源）、音源元数据、按 id 取插件
plugins/builtin/
  source-factory.ts     用内置数据造一个「行为真实」的模拟源（可设不可播比例 / 延迟）
  demo-source-info.ts   内置示例源的**元数据**（无 mock 数据依赖，桌面端唯一会进包的部分）
  mock-source.ts        内置示例源：始终可播，作为自动回退兜底
  alternate-sources.ts  模拟源 B / C（各带不同的不可播比例与延迟，纯本机模拟）
  demo-sources.ts       三个演示源的集合，**只被动态 import**
plugins/index.ts        顶层判定 Tauri 宿主：没有宿主才动态注册演示源（`demoSourcesEnabled`）
```

> **开发/生产数据隔离（R53）**：演示源只属于**浏览器预览**。`plugins/index.ts` 在模块顶层
> 判定 `'__TAURI_INTERNALS__' in window`（与 `window.service.isTauri()` 同一条件，**不 import
> services**，避免 plugins↔services 环），只有没有宿主时才 `import('./builtin/demo-sources')`——
> 桌面端产物里 `src/mock/**` 与那份随包测试音频因此不在主包，也不会被加载。
> 服务层一律「**只有没有核心才退回 mock**」（见下），界面不得用演示数据冒充用户数据。

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
  <page>/components/*         该页面私有组件（如 ranking 的 TopListNav 分类树 / ChartList 列表）
  download/{downloading,downloaded}/index.tsx   子路由页面
```

- 通用组件不含业务数据，数据与文案由调用方注入。
- 列表列定义集中在 `src/config/table.config.tsx`，视图只做组合。
- 视图统一用 `<Page>` 提供标题 / 副标题 / 工具条，保证间距规格一致。
- **一个页面可以覆盖形状相同的多个对象**：`views/collection` 用 `/collection/:kind/:source/:id`
  同时承载源侧专辑与精选歌单（`catalog.album` / `catalog.playlist`）——它们都是
  「一组曲目 + 一点元数据」，复制成两个页面只会让改动要改两遍。
- **封面统一走 `utils/cover.ts`**：核心给图片地址、mock 给渐变、核心对推荐结果给空串，
  三条路径收口成一个 `coverStyle()`，避免「把 URL 当渐变用」或留透明块。
  消费点包括播放条 / 歌词页 / 榜单 / 收藏卡片 / 相似推荐，以及**业务列表标题列的缩略图**
  （`table.config.tsx` 的 `titleColumn`，尺寸来自 `components.table` 的 token）。
- **本地文件的内嵌封面**（R37）：扫描时把文件里的图片落进 `<data>/cache/covers/<hash>.<ext>`
  （文件名 = 源路径 SHA-256 前 16 字节，分隔符归一成 `/`），`library.local.list` 给一个
  回环地址 `http://127.0.0.1:<port>/cover/<name>`，由媒体代理按字节回放（只服务该目录、名字必须合规）。
  因此本地曲目的封面与插件封面在界面里**同形**：都是图片地址，没有就走渐变。

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
              **只有核心认识的插件源才问核心**（`isCoreSource`）：本地文件与内置演示源都没有
              插件，问了只会拿到 `not_found` 并在日志留下误导人的「插件未安装：local」；
              桌面端插件源：catalog.lyrics（核心 → 插件 getLyric）只交原文 →
                     utils/lyrics.ts 解析成行（LRC / 纯文本 / 译文对齐）
              浏览器：mock 生成，形状一致
     → 音源：services.catalogService.resolveUrl(track) → 桌面端 playback.resolve 返回
              **回环流代理**地址（http://127.0.0.1:<port>/m/<token>）；
              插件未安装时退回内置示例源（仅用于验证播放链路）
     → hooks/useAudioEngine：把 store 状态接到 services/audio.service.ts 的 <audio>
     → <audio> timeupdate → store.player.setProgress(elapsed, duration)
     → <audio> ended → store.player.next() → 结算本次播放（playback.report）
     → 音源不可用（播放失败 / 无地址）→ store.player.markUnplayable()
       → hooks/usePlayerEngine 接管，用模拟时钟推进进度
```

`player.playable` 是唯一开关：有真实音源时进度由音频引擎回写，没有时用回退时钟，
UI 无需关心差别。

**`Content-Type` 由代理决定，前端不做 Blob hack**：上游用 `application/octet-stream`
（或干脆不给）下发音频时，代理按**地址扩展名**补一个类型（`.m4s` → `audio/mp4`）；
上游给出具体类型时一律照抄。于是 `<audio>` 的 `src` 永远是代理 URL，不需要
「抓成 Blob 再强制 `audio/mp4`」那条路径（R11 删除）。

## 6. i18n

`src/i18n/locales/{zh,en}.json`，命名空间：
`app / nav / common / search / toolbar / sidebar / player / column / quality / source /
recommend / confirm / skin / errors / page.<页面>`。
组件内不出现中文字面量；冒烟测试校验「键集合一致」、「无死键」、「每个错误码都有 zh/en 文案」。

**错误文案走错误码，不解析 `message`**：契约把 `CoreError.message` 定义为**面向开发者**的说明
（会带字段名、上游原文、`details` 这类内部词），因此界面统一经
`src/i18n/errors.ts` 的 `errorText(t, error)`：按 `errors.<code 点号换下划线>` 取本地化文案，
查不到才退回 `message`（这样英文界面里不会混进中文，也不会冒出「sha256」之类的词）。
事件同理——`download:error` 事件带 `code`，下载页据此显示失败原因（`DownloadTask.errorCode`）。

## 7. 个性化推荐

```
本机数据（播放历史 + 收藏 + 本地曲库 + 自建歌单）
   ↓ core/src/recommend.rs（**唯一一份实现**）
口味画像：标签权重 + 歌手权重（播放次数取对数、12h 半衰期衰减、收藏加权）
   ↓ rank_tracks / rank_albums / rank_playlists
候选池（本机曲库 / 专辑 / 自建歌单）按命中强度排序
   ↓ 理由生成
可解释推荐理由：artist（因为你听过 X）/ tag（因为你喜欢某标签）/ trending（回落）
   ↓ recommend.home 命令 → services/recommend.service（桌面端）/ mock 预置数据（浏览器）
推荐页三个区块：单曲 / 专辑 / 歌单，每条都带 ReasonChip
```

- **打分算法只在核心一份**：`core/src/recommend.rs`（含 7 项单测）；前端的
  `src/utils/recommend.ts` 已随服务层切换**删除**，浏览器预览改用 `src/mock/recommend.mock.ts`
  的预置数据（形状与核心返回一致，视图不分支）；
- `recommend.home` **零外部请求**（ADR-0005：用户动作之前不发起任何外部请求）；
  **源侧推荐**是另一条显式命令 `catalog.recommend{source}`（插件自己的 `getRecommend`），
  在推荐页单列一栏「来自当前音源」，**按源路由**（核心认识的源走核心，内置演示源走本地实现）；
- **推荐反馈由界面显式上报**（`recommend.feedback`，append-only 落库、下次打分消费）：
  - 推荐卡片上的「不感兴趣」= `skip` + `progress: 0`（契约里唯一的显式负反馈动作）；
  - 播放器在**切歌 / 停止 / 播完**时按进度报 `skip`（`< 0.5`）或 `complete`（`≥ 0.9`）——
    核心的画像只消费播放次数与时间（不看 `playedSec`），不报的话「听 5 秒就切」与「完整听完」没有区别；
  - **暂停不算倾向**（去接个电话不该压低这首歌的权重），因此反馈单独用 `feedbackPlayId` 去重，
    与历史那条 `reportedPlayId` 分开。

## 7.1 播放历史：谁在写

```
播放（player.start / toggle / stop / 曲终切歌）
   ↓ services.reportPlay（playback.report）
实际播成的音源 + 真实播放秒数 + completed + 曲目快照
   ↓ core/src/library.rs（与 library.history.push **同一份实现**）
play_history 表 → 最近播放视图 / 推荐画像输入
```

- 前端**只有这一条**写历史的路径：`library.history.push` 是核心侧原语，由 `playback.report` 复用；
  两处都写会让同一首歌的播放次数被记两次（store 里的 `recordPlay` 因此只做乐观 UI）；
- 上报时机是「放完 / 被切走 / 暂停 / 停止」，因此记的是**真实听过多久**，不是开始播就记 0 秒。

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

## 9. 接口契约

> ⚠️ 本节内容已并入 **§11 本机核心契约**。原先的 HTTP 契约（`src/api/types.ts` +
> `src/api/contract.ts` + `docs/contracts/backend-api.md`，含 `auth` 域、Idempotency-Key、
> 游标分页）随「不提供服务器」的产品定位整体作废，已归档在 `docs/archive/`。

## 10. 主题皮肤（复杂定制）

皮肤 = `presets.json` 的一个条目，可覆盖**任意令牌组**
（palette / scheme / typography / radius / spacing / shadow / motion / zIndex / components），
未声明的字段继承 `theme.config.json`：

- 内置 11 套：配色类（暮光紫 / 深海蓝 / 青柠 / 樱花 / 暖阳 / 石墨）、
  密度类（紧凑 / 宽适）、复杂类（圆润 = 大圆角 + 柔和阴影 + 慢动效；
  锐利 = 小圆角 + 无阴影 + 快动效；高对比 = 更强边框字重 + 更大字号）；
- 用户导入：主题市场「导入皮肤」读取 JSON → **桌面端由核心校验**（`skin.preview` 的结构 +
  **令牌键名白名单**，再看 `skin.install` 落盘）→ `installSkin`（立即应用）；
  「导出当前皮肤」优先用核心落盘的原文（`skin.export`）；自定义皮肤可删除（走二次确认）；
- 浏览器预览（无核心）退回 `src/theme/presets.ts` 的本地宽松解析 + store 持久化——
  两条路径返回**同一形状**（`SkinImportOutcome`），视图不分支；真机上一律以核心为准；
- 导入只做校验、不执行任何代码；解析失败给出具体原因，被拒的令牌键名**逐条列出**
  （`skin.token_rejected`，见契约 §7）。

## 11. 本机核心契约（无服务器形态）

产品**不提供任何服务器**（见 `docs/adr/0003-no-server-local-core.md`）：无账号、无市场后端、
无遥测、无 web 端。因此不存在 HTTP 边界——能力一律由 **Rust 本机核心**通过 Tauri IPC 暴露：

```
React（UI / store / services）
   │  invoke(command) / listen(event)      ← 无 HTTP、无端口、无 CORS、无 JWT
Rust 本机核心（**已实现**：契约里的 61 条命令 / 8 类事件，`cargo test -p gently-core` 219 项）
   ├─ 插件宿主（内嵌 QuickJS + 权限白名单）与订阅索引缓存
   ├─ 曲库聚合（流式搜索、跨源去重、候选排序、播放回退）与缓存
   ├─ 本地曲库（symphonia 读标签/时长/内嵌封面）+ 封面缓存 + FTS5 检索
   ├─ 回环媒体代理（仅回环、一次性 token、Range 与请求头注入、SSRF 防护；另服务 `/cover/<name>`）
   ├─ 本机库 / 播放史 / 收藏 / 歌单（SQLite + FTS5）
   ├─ 推荐（画像打分，**零出网**）
   ├─ 下载管理（本地文件系统）
   ├─ 皮肤仓库（惰性 JSON 文档 + 令牌白名单校验）
   └─ 第三方凭据（OS keyring，按插件隔离）
```

契约两处，且只有两处：

1. `docs/contracts/local-core-api.md`——规范正文：61 条命令 + 8 类事件、错误码表、
   多音源策略、插件与皮肤模型、本机存储布局、安全与信任模型；
2. `src/api/index.ts`——上述契约的前端类型（只有类型，无实现）。

三条硬规则：

1. **命令永不抛异常**：Rust 侧返回信封 `{ok, data|error, traceId}`（不是 `Result`），
   只有 IPC 反序列化失败/panic 才 reject，由前端薄封装转成 `common.internal`；
2. **UI/store 不得直接 `invoke`**：一律经 `src/services/**` 封装（与第 4 条数据门面同源），
   接入时只改这一层；
3. **社区资源是不可信代码**：插件安装走 `plugin.preview` → 用户显式同意 → `plugin.import`；
   不执行安装脚本；插件 JS 只在 QuickJS 沙箱内运行，网络限于清单 `hosts`；
   第三方凭据只进 OS keyring，日志与 SQLite 不出现明文。

**事件名的传输约束**：事件经 Tauri 的事件系统送到前端，而 Tauri 只接受字母数字与 `-` `/` `:` `_`
（`tauri::event::EventName::new`）——**事件名一律冒号分段**（`catalog:search:done`），
名字同时就是契约名与前端常量（`src/services/core.events.ts` 的 `CORE_EVENTS`），不设第二套映射。
踩过的坑：带点号的名字 `emit` 直接报错，`TauriEventSink` 把它降级成一条 `tracing::warn!`
（「事件丢一次不影响命令结果」），于是**桌面上 8 个事件全部丢失**而单测/冒烟全绿——
症状是「流式搜索只能等超时、下载进度永远不动」。现在 Rust 单测、契约守卫（四处比对 + 字符集）、
前端冒烟三层都拦这件事。

**按源路由（核心源 vs 内置演示源）**：桌面上核心里是真正的插件源（`plugin.list` 是权威，
只能由 `catalog.*` 命令执行）；**内置演示源只活在浏览器预览里**（`src/plugins/builtin`，
核心完全不认识，桌面端连注册都不会发生，见上）。`src/services/core.sources.ts` 缓存核心的插件清单
（`rememberCoreSources` + TTL 5s 的 `ensureCoreSources`），`catalogService` 按**源**路由：
核心认识的源走核心；浏览器预览里核心不认识的演示源走本地实现；核心回 `common.not_found` 只当
「核心不认识这个源」（路由表过期/插件刚卸载），退回本地实现而不是报故障
（`searchAll` 的本地那一路额外要求 `demoSourcesEnabled && !coreAvailable()`）。
判定错一次就会出现「界面把正常状态显示成故障」或「用户选了 A 源却拿到演示数据」。

**mock 数据的边界**：mock 只在**没有核心**（浏览器预览）时出现（`libraryService` / `catalogService` /
`recommendService` 按 `coreAvailable()` 分流——插件列表、推荐、专辑/歌单详情、聚合搜索都适用）。
核心可用却读失败时，门面返回空并如实报错，**绝不退回 mock**——
否则用户看到的是示例数据冒充自己的收藏、歌单、本地曲库、下载与推荐，比空列表糟糕得多。
**「一个源都没装」是正常状态，不是故障**：`catalogService.defaultSourceId()` 返回 `null`
（不抛异常）、`getActiveMusicSource()` 返回 `undefined`，界面渲染诚实的空态
（搜索页说「还没有安装任何音源」，设置页说「还没有安装任何插件」），
而不是把 `null` 当异常抛在渲染期（应用没有错误边界，那会整页白屏）。
写入是乐观更新 + 落库，下一次 `load()` 以核心为准。

**桌面端分支怎么测**：冒烟跑在 Node（没有 Tauri），因此 `pnpm smoke` 里用 `withFakeCore()`
临时替换 `window.__TAURI_INTERNALS__`——`invoke`（两种调用形态）、`transformCallback` / `runCallback`
（语义照抄 tauri 的 `scripts/core.js`）与 `plugin:event|listen`，并按 Tauri 的字符集校验事件名。
假宿主因此能**真的推事件**（`host.emit(event, payload)`），下载进度、扫描进度、流式搜索的
partial/done 都在冒烟射程内；订阅过的名字会被断言必须来自 `CORE_EVENTS`。

**插件 ABI**：主形态是**单文件 `.js` + 文件头注释元数据**（前 60 行解析 `@name`/`@id`/`@version`/
`@hosts`/`@credentials` 等），目录包（`plugin.json` + `entry`）降为需要多文件/资源时的高级形态；
ABI 为 9 个顶层函数——`search` / `getMediaSource` 必选，`getTrackInfo` / `getAlbumInfo` /
`getPlaylistInfo` / `getLyric` / `getTopLists` / `getTopList` / `getRecommend` 可选。
**能力探测**：函数不存在即对应命令返回 `common.not_implemented`（UI 隐藏入口），不视为错误。
前端 `src/plugins/**` 只是浏览器 mock 兜底的最小接口，**不是 ABI**。

**订阅分发**：订阅 = 一个 `repository.json`（与 Legado 社区书源仓库规范同构：`name`/`version`/
`updatedAt`/`url` + `sources[]`，字段只增不改），命令 `plugin.subscriptions.list/add/remove/refresh`
+ `plugin.catalog.list`，`ImportSource{kind:'catalog'}` 实现一键安装——**分发不依赖我方服务器**。
安装仍需 `plugin.preview`：一键安装 + 一个权限摘要确认框（沙箱与同意流程的摩擦不能大到让社区绕开）。

**媒体传输**：必须由核心提供**本地流代理**，因为 WebView 的 `<audio>` 无法设置 `Referer` /
`User-Agent` / `Cookie`（真实音源大量需要），且拖动进度需要 `Range`，本地文件也读不到任意路径。
代理**仅绑定回环地址**、地址带**一次性 token**、转发 `Range`/`206` 并注入源声明的请求头；
`playback.resolve` 的 `streamUrl` 指向代理，`originUrl`/`headers` 只用于排障；对指向内网/回环/
链路本地地址的媒体地址返回 `media.blocked_address`（SSRF 防护）。本地文件播放走这条通道，
替换前端现有的 Blob / `audio/mp4` hack。

相对 HTTP 形态**删掉**的东西：鉴权/JWT、限流、CORS、幂等键、游标分页的跨请求语义、
OpenAPI-over-HTTP 代码生成、Postgres/Redis/BullMQ/Docker。**新增**的必需能力：
本地曲库扫描（含音频元数据探测）、插件导入与同意流程、凭据管理、本机诊断
（`system.status` / 打开日志目录——无遥测意味着问题只能靠本地日志定位）。

未来单一来源：Rust 核心落地后用 `specta`/`tauri-specta` 从 Rust 结构体生成 `src/api` 的类型，
该文件退化为生成产物（M1 出现第一批真实 DTO 时接入）。在此之前它是权威定义。

**命令入口只有一个**：Tauri 的命令名来自 Rust 函数名，无法表达 `plugin.import` 这种点号名字，
而契约名是跨语言 ABI，因此只注册 `core_invoke`（参数 `{command, params}`），
由 `core/src/commands.rs` 按契约名 `match` 路由。已登记未实现 → `common.not_implemented`；
名字未登记 → `common.not_found`（后者是 bug，测试会遍历契约清单确保不出现）。
命令名清单的权威在 `core/src/contract/commands.rs`，由 `pnpm check:contract`
（`scripts/check-commands.mjs`）与文档比对：命令、事件、错误码三处任一漏改都会失败，
其中**事件是四处比对**（契约 §3 表格 ↔ `core/src/events.rs` 的 `events::ALL` ↔
`src/api/index.ts` 的 `CoreEventMap` ↔ `src/services/core.events.ts` 的 `CORE_EVENTS`）
并额外校验事件名落在 Tauri 接受的字符集内。

**契约之外还有一道「界面可达性」守卫**（`scripts/check-reachability.mjs`）：契约守卫只能证明
「每条命令都有前端封装」，证明不了「用户点得到」——R28 的 `library.local.scan` 就是全链路齐全、
界面却没有入口。这条守卫静态解析三层（`views/components` → `store actions` → `services` → 命令），
把可达性算到不动点，报出「有实现、有封装，但界面走不到」的能力；**store 不算根**
（切片里写了调用只说明 store 有这个能力，没有视图用那个 action 就等于摸不到）。
白名单 `DELIBERATE` 只放产品取舍并写理由，每次运行都会打印，接了界面会提示移除。

## 12. 与 Tauri 的边界

- `services/window.service.ts` 封装最小化 / 最大化 / 关闭 / 置顶 / 小窗；
  浏览器环境为安全空操作，仅在 Tauri 宿主动态 `import('@tauri-apps/api/window')`。
- 后续本地文件、下载落盘、插件运行时等能力同样从 `services/` 进入，视图不直接调用 Tauri API。

## 13. 遗留与归档

`docs/archive/` 保存未接入产品（或已作废）的实现，**不参与构建**：

- `core-draft/`：可视化编辑器的 AOP / modifier / registry 草案（缺类型定义，未接入）。
- `legacy-ui/`：旧版组件目录（table / input / radiobtn / icons / logo / tool / Sidebar / Player / card / section）。
- `legacy-views/`：旧版 `*_view` 页面目录（含未完成的 ranking_view 占位实现）。
- `contracts/backend-api-http.md`：HTTP 服务契约（产品定位改为无服务器后作废，多音源与错误模型被沿用）。
- `server-ts/`：TypeScript 后端骨架（41 个 HTTP 端点 + JWT/幂等/限流/Docker/PG/Redis），
  同上作废；其中「清单唯一目录 + 遍历清单的守卫测试」「统一信封与错误码映射」
  「插件清单的 permissions/credentials 设计」已迁入新契约。

归档原因：目录树按单一职责重组（前三条）；产品形态从「云服务」改为「纯桌面 + 本机核心」（后两条）。
恢复前请先确认与 `docs/adr/0003-no-server-local-core.md` 不冲突。
