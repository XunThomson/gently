---
status: active
last_verified: 2026-11-02
owner: gently
scope: 当前迭代状态与下一步
token_budget: 250
tldr: 当前 R136（ANDROID-PLAN §8 的「导入进度条」）：拷 1.3 GB 文件时界面只显示「等待选择…」。做法是**原生维护进度快照、前端在导入期间轮询**——Kotlin 侧 `ImportPlugin.Progress`（active/fileName/fileIndex/fileCount/bytesDone/bytesTotal/imported/failed/skipped）由 64 KiB 分块拷贝累加，宿主新增 `import_progress` 命令（桌面端回 active:false），`ScanPanel` 每 250ms 读一次并显示「正在导入 1/1 · 文件 · 45%」。为什么轮询：Tauri 移动插件只有 Rust → Kotlin 方向，Kotlin → Rust 没有回调通道（GOTCHAS §69）。真机：40 秒内 16 个不同快照、bytesDone 194MB→1.32GB、结束 bytesDone==bytesTotal，界面确有百分比；导入后曲库 4→5、清理副本回到 1。smoke 566，契约 76 命令 / 9 事件。
---

# STATE

## 本轮目标（第一百三十七轮）

> 用户报了 5 条移动端问题：后台播放失效 / 抽屉不能滑动打开 / 点抽屉导航项有时没反应（「设置页改设置白屏」的现场）/
> 歌词页的返回按钮应该去掉（交给系统返回）/ 列表的「卡片」观感不符合主流。

### 1. 逐条处理

| 问题 | 结论与改动 |
|---|---|
| **后台播放** | 真机多次实测：**元素没被系统暂停时**后台能继续播（熄屏 90s：+99s；Home+熄屏 131s：+131s）。本轮 150s 那次抓到了它停的现场：logcat 里 `HwMedia::Play hbs_autoplay_ = 0` + `UpdatePlayState should_be_playing = 0`——华为 WebView 在页面不可见时**拒绝 `play()`**，元素被系统暂停后就再也叫不回来。同时发现我第一版的后台恢复会走 `resume()` → 失败就 `reload()`，于是每 5 秒重载一次、进度被反复清零（熄屏 150s 只走了 13s）。改：① 后台只 `nudge()`（叫一声 `play()`，**不重载**、不报错）；② 看门狗在页面隐藏时不再判「媒体元素没有开始播放」（后台定时器被延后，很容易把正常播放误判成失败）；③ 僵死判定留给回到前台 |
| **抽屉滑动打开** | `MobileShell` 加横滑手势：起手点离屏幕左边 ≥ 48px（避开系统返回手势区——R124 的负结果），横向位移 ≥ 72px 且明显大于纵向才触发；`.content` 设 `touch-action: pan-y`；播放条标 `data-drawer-swipe="off"`（进度条自己就是横向拖动）；滑动后 **300ms 内**那一次 click 被吃掉（只吃这一下，不能把抽屉里紧接着的点击一起吞了） |
| **抽屉导航项有时没反应** | 真机复现：冷启动后第一次「抽屉 → 设置」必失败。根因是 `useBackToClose` 收起时的 `history.back()` 与抽屉里的 `navigate()` 抢同一条历史（`navigate` 在 RouterProvider 里**异步落地**）。修：hook 返回「这次别动历史」的句柄，抽屉换页改为 `navigate(path, {replace: 标记存在})` 直接顶掉标记——页换了、历史不多一条。真机复测：冷启动第一次即成功，连续 8 次 0 失败、历史每次只增 1 |
| **设置页改设置白屏** | 本机**没复现**（主题模式 / 语言 / 音质三组 / 列表展示方式 / 背景开关逐项点过，无异常、DOM 完好；也排除了滚动错位）。改法：给路由内容加 `RouteError` 错误边界——渲染抛错时只坏内容区、导航与播放条还在，显示「这个页面出错了」+ 可展开的出错信息 + 重试 / 重新加载，`console.error` 留堆栈。这样即使还有未知触发条件也不会是白屏 |
| **歌词页返回按钮** | 手机形态不再渲染「返回」（桌面保留——那边没有系统返回）。真机：`/now-playing` 的按钮只剩「封面作为背景 / 歌词工具」，系统返回 `/now-playing` → `/setting` → `/search` 逐级退回 |
| **列表卡片观感** | 手机列表拆掉外层卡片：容器去掉边框 / 圆角 / 白底，行只留 1px 分隔线、底色交给页面（`.container[data-layout='mobile']`；容器也带 `data-layout`，因为 WebView 是 Chromium 92，不能用 `:has()`）。补回「播放中的行」底色（新规则特异性更高会盖掉 `.row.active`） |

### 2. 验证（真机 `CDY-AN00`）

| 项 | 结果 |
|---|---|
| 滑动开抽屉 | `input swipe 250 1000 800 1000 220` → 抽屉打开；在播放条上横滑（y≈2280）**不打开**（`data-drawer-swipe="off"` 生效） |
| 抽屉导航 | 冷启动第一次「设置」即生效；连续 8 次来回 0 失败，历史每次 +1（不再留标记垃圾） |
| 歌词页 | 无「返回」按钮；系统返回逐级退回（`/now-playing` → `/setting` → `/search`） |
| 列表 | `release/screenshots/r137-mobile-list-flat.png`：列表直接铺在页面上，无卡片外框 |
| 后台播放 | 见上一栏：能播的后台场景确实能播；被系统暂停后 JS 叫不回来（华为 WebView 的 autoplay 门禁），且已不再反复重载毁进度 |
| 门禁 | `pnpm typecheck`；`pnpm smoke` **575**（566 → +9）；契约 76 命令未变 |

### 3. 未做 / 下一步

- **后台播放的硬骨头**：`play()` 在页面不可见时被 WebView 拒绝，属原生层问题。正路是让**原生侧持有音频焦点**：
  `PlaybackService` 的 `MediaSession` 主动 `AudioManager.requestAudioFocus(AUDIOFOCUS_GAIN)`（暂停/停止时 abandon），
  让系统认为音频归本应用所有；另一条是页面侧维护 `navigator.mediaSession`（Chromium 据此判定「这是后台媒体」）。
  两条都要真机长测（≥5 分钟、含息屏），下一轮做；
- **设置页白屏**：本机复现不出。请再触发一次，把错误边界上「出错信息」那段发我；
- 列表观感只做了「去卡片」：封面尺寸 / 行高 / 分隔线粗细还可以继续往主流靠。

## 本轮目标（第一百三十六轮）

> ANDROID-PLAN §8 收尾清单里的「导入进度条」：拷一个 1.3 GB 的文件时，界面从头到尾只有
> 「等待选择…」，用户无法判断是在拷、卡住了，还是根本没开始。

### 1. 做法：原生维护快照，前端在导入期间轮询

| 层 | 改动 |
|---|---|
| Kotlin `ImportPlugin.kt` | 新增 `Progress` 快照（`active` / `fileName` / `fileIndex` / `fileCount` / `bytesDone` / `bytesTotal` / `imported` / `failed` / `skipped`）+ `importProgress` 命令；拷贝改成 64 KiB 分块循环，每块累加 `bytesDone`；选完先按 SAF 的 `SIZE` 算总字节；**跳过的文件也计入已完成字节**，读到的比声明的小时补差额（总进度只增不减，不会「卡在 62%」）；取消 / 新一轮开始时把快照收掉 |
| 宿主 `importer.rs` / `lib.rs` | `ImportProgress` 结构 + `import_progress` 宿主命令（桌面端回 `{active:false}`） |
| 契约 | 桌面层命令表补齐 `import_audio` / `imported_dir` / `import_progress`（原先只登记了 `web_login`） |
| 前端 | `services/import.service.ts::importProgress()`（无宿主 → `null`，**不伪造进度**）+ 纯函数 `importProgressText()`；`ScanPanel` 导入期间 250ms 轮询一次，按钮旁显示「正在导入 1/1 · r136-1g.mp3 · 5%」 |
| 文案 | `page.local.importProgress` / `importProgressPercent`（zh + en） |

为什么是轮询而不是事件：**Kotlin → Rust 没有回调通道**（Tauri 移动插件只有 Rust → Kotlin 方向），
而 Rust → Kotlin 是现成的。一轮导入几十次 IPC，代价可以忽略（GOTCHAS §69）。

### 2. 验证（真机 `CDY-AN00`）

把 105 MB 的演示视频复制成 332 MB / 1.3 GB 的 `.mp3` 放进 `/sdcard/Download`，在真机上从系统选择器导入：

| 项 | 结果 |
|---|---|
| 进度链路（Kotlin → Rust → JS） | 40 秒窗口内采到 **16 个不同的 `active:true` 快照**：`bytesDone` 从 194,707,456 涨到 1,318,715,392，`bytesTotal` 恒为 1,326,041,664；结束后转 `active:false` 且 `bytesDone == bytesTotal`、`imported: 1` |
| 界面 | 导入中的 WebView 图显示「**正在导入 1/1 · r136-1g.mp3 · 5%**」（`r136-android-import-progress.png`） |
| 导入 + 扫描 | 「已导入 1 首」；曲库 4 → **5 首**，`r136-1g 1264.6 MB` 入库；扫描统计「扫描 4 个文件，新增 1，跳过 3」 |
| 取消路径 | 关掉选择器后快照回 `active:false`（界面不会留「上次导入到 62%」的假进度） |
| 清理 | 「清理副本」→ 曲库 5 → **1 首**（`probe` 留下），`run-as … ls files/music` **空**；`/sdcard/Download` 的测试文件已删 |

### 3. 门禁

`pnpm typecheck` 通过；`pnpm smoke`：**566**（562 → +4：百分比 / 未知总量不编百分比 / 序号夹回 / 无宿主返回 null）；
`pnpm check:contract` 76 命令 / 9 事件；`pnpm verify` 全绿。

### 4. 未做

- 音乐目录**导出**（把 `filesDir/music` 经 SAF 另存到用户可见位置）仍是 §8 余项；
- 进度到「文件级 + 字节级」为止，没有速度 / 剩余时间（要额外采样窗口，目测收益不值）。

## 本轮目标（第一百三十五轮）

> R110 留下的最后一件小事：上游用 `HTTP 200 + HTML 错误页` 冒充音频时，界面只会说
> 「音频加载失败（地址可能已过期）」——用户会一直等，而正确动作是换源 / 重新登录。
> 判定其实早就在代理里做了（R110 起就有一条 WARN），只是**没进界面**。

### 1. 做法：判定归核心，文案归前端

| 层 | 改动 |
|---|---|
| 核心 `media.rs` | 代理转发时按字节下判定：`classify_upstream`——嗅出容器 → `audio`；开头是 HTML / JSON / 纯文本（含 BOM）→ `notAudio`；**认不出的二进制、非 2xx 一律不下结论**。按曲目引用记进 `verdicts` 表（上限 64 条），`publish` 新地址时清掉旧判定 |
| 契约 + 命令 | 新命令 `playback.diagnose{ref}` → `UpstreamVerdict \| null`；引用解析复用 `library::resolve_ref`（字符串与 `TrackRef` 都认） |
| 前端服务 | `coreDiagnoseUpstream()` + `catalogService.diagnoseUpstream(track, sourceId?)`：无核心 / 查不到 → `null`，核心报错只留 debug（诊断失败不该盖住真正的失败原因） |
| 前端 store | 只在 `markUnplayable` 的**判死**分支问核心；结论是 `notAudio` 就把 `playbackError.kind` 换成 `notAudio`（顺带丢掉那句英文 `MediaError` 噪声）。三条护栏：切歌 / 已重试成功 / 结论不是 notAudio 都不动当前状态 |
| 文案 | 新失败类型 `notAudio` → `player.failureNotAudio`（zh/en）：「音源返回的不是音频（可能是错误页 / 需要登录 / 链接已失效）」 |

界面入口不需要新增：播放条 / 迷你播放器 / 手机播放条的失败提示本来就渲染 `playbackError`。

### 2. 验证

- `cargo test -p gently-core`：新增 4 条单元断言（判定口径、HTML 错误页端到端记账、新发布清旧判定、诊断表上限）
  + `playback.diagnose` 命令级断言（无判定 → `data: null`；坏引用 → `common.invalid_argument`）；
- `pnpm smoke`：**562**（555 → +7：notAudio 文案 / 服务层读结论 / 引用口径 `source:rawId` /
  无核心不伪造 / **store 真的把原因换成 notAudio** / 没有判定时不改口）；
- `pnpm check:contract`（76 条命令、9 类事件）与 `pnpm check:reachability` 通过——
  新命令的调用点在 store，不是「有封装没人用」；
- **没有真机 / 打包版视觉复核**：要看到这句话，得有一个真的回错误页的上游；仓库里没有、按 ADR-0005 也不该有。
  这条按「核心单测 + 假宿主 store 断言」验收，界面与既有失败提示走的是同一条渲染路径。

### 3. 未做 / 边界

- 判定只描述「上游那几个字节」，**不是**「播放失败的原因」：`unknown`（我们不认识的封装）不会改口；
- 只在判死分支问核心：换源 / 重解析期间不打扰，避免把一次失败放大成两次 IPC；
- 旧判定会被下一次 `playback.resolve` 清掉，「上次不是音频」不会一直挂在这首歌上。

## 本轮目标（第一百三十四轮）

> #5 动画穿模的**真机复核**（R133 交付时记的是「已落地、待真机确认」）：开抽屉 / 开行操作面板时，
> 到底有几层在动；顺带回答「R133 那两条规则真的按预期生效了吗」。

### 1. 先量，再改

真机（`CDY-AN00`，WebView Chromium 92）通过 CDP 用 `CSS.forcePseudoState` 强制 `:active`，
在「浮层关 / 开」两种状态下读 `getComputedStyle` 的 `background-color` 与 `transition`；
再用 `document.getAnimations()` 看还有谁在动。复核暴露两件事：

| 发现 | 证据 |
|---|---|
| **行规则只压住了一半**：`[data-overlay='open'] .content [class*='row']:active` 与表格自己的 `.table[data-layout='mobile'] .row:active` **同权重 0,4,0**，平局靠源码顺序；打包后顺序不由我们决定 | 行被强制 `:active`（抽屉打开）→ `transition: none` 生效、`background` 仍是 `rgba(0,0,0,0.04)`（= `--table-row-hover-bg`，还在亮） |
| **规则越界到浮层自身**：R133 用的是全局 `[data-overlay='open'] button:active`，抽屉项与底部面板的动作按钮同样命中——按选择器即可判定（没装机验证：这条改在装机之前） | 抽屉项/面板按钮本会得到 `background-color: transparent` |

### 2. 改动（纯 CSS，两处）

| 文件 | 改动 |
|---|---|
| `MobileShell.module.css` | 抑制收窄到**被浮层盖住的那两层**：`html[data-overlay='open'] .headerAction:active`、`… .content button:active`；浮层自己的按压反馈不再被压 |
| `DataTable.module.css` | 行的覆盖写在被压的那条规则旁边，并用 `html` 把特异性提到 0,4,1：`html[data-overlay='open'] .table[data-layout='mobile'] .row:active { background: transparent; transition: none }` |

### 3. 验证（真机 `CDY-AN00`）

| 被强制 `:active` 的元素 | 浮层关闭 | 抽屉 / 面板打开 |
|---|---|---|
| ☰ 顶栏按钮 | `rgba(0,0,0,0.08)`（`--bg-active`） | `rgba(0,0,0,0)` + `transition: none` ✅ 压住 |
| 列表行 | 从 0 过渡到 `rgba(0,0,0,0.04)`（`--table-row-hover-bg`） | `rgba(0,0,0,0)` + `transition: none` ✅（修复前是 0.04） |
| 播放中的行 | `--brand-soft` | `rgba(0,0,0,0)` ✅ |
| 行的 ⋯ | `--bg-active` | `rgba(0,0,0,0)` ✅ |
| 抽屉项 / 面板动作按钮 | — | `rgba(0,0,0,0.08)` ✅ **保留**（点的反馈还在） |

- `document.getAnimations()` 过滤掉浮层内部后：抽屉打开后 **0 条**；入场期间只有抽屉自己的
  `_drawerIn_` / `_scrimIn_`（50 ms / 150 ms 采样）。行操作面板打开后浮层外同样 0 条。
- `html[data-overlay]` 标记：打开即 `open`，点空白关掉后清掉（抽屉与行操作面板两条路都验）。
- `pnpm typecheck` 通过；`pnpm smoke`：**555**（纯 CSS + 已有 hook，无新增断言）。
- 截图：`release/screenshots/r134-android-drawer.png`、`-row-sheet.png`。

### 4. 结论

- **用户 10 条体验反馈到此全部落地**：#4 / #8 / #3 / #10（R121–R130）、#2 / #6（R123）、#7 / #9（R122）、
  #5（R133 落地 + R134 真机复核）。#1 只剩「左边缘横滑」是**负结果**（被系统返回吞掉，GOTCHAS §67），
  其余手势（系统返回关浮层、底部面板下拉收起）已成立。
- 方法沉淀：**「层级 / 遮罩 / 按压态」类验收用「强制伪类 + `getAnimations()`」，别靠截图数像素**
  （GOTCHAS §68）——截图看不出「哪个元素在动、动了几层」。
- 未做：R133 §3 里「若仍有穿模就整层裁掉」的第二刀**不需要了**（已量到浮层外 0 条动画）；
  抽屉/面板的**退场**动画仍未做（组件卸载即消失，要做需要维护额外状态）。

## 最近三轮

| 轮次 | 主题 | 结论 | 详情 |
| R137 | 移动端反馈批次：后台播放、滑动开抽屉、导航项点不动、歌词页返回、列表去卡片、白屏兜底 | ① 后台播放：抓到现场是华为 WebView 在页面不可见时拒绝 `play()`（`Hbs autoplay=0`）；修掉「后台 resume()→reload() 每 5s 清零进度」（熄屏 150s 只走 13s）改成只 `nudge()`，看门狗在隐藏时不判失败。② 抽屉横滑打开：起手离左边 ≥48px、位移 ≥72px、播放条排除、只吃紧接的 click。③ 抽屉导航偶发没反应：`history.back()` 与异步 `navigate` 抢历史 → 换页用 replace 顶掉标记 + hook 返回「别动历史」句柄；冷启动首次即成功、8 次 0 失败。④ 白屏本机未复现，加 `RouteError` 错误边界（出错只坏内容区 + 可反馈的出错信息）。⑤ 手机歌词页去掉「返回」，靠系统返回。⑥ 手机列表拆外层卡片改连续列表。smoke 575 | [本轮](#本轮目标第一百三十七轮) |
|---|---|---|---|
| R136 | ANDROID-PLAN §8：导入进度条 | 原生维护进度快照（`ImportPlugin.Progress`，64 KiB 分块累加 bytesDone、按 SAF SIZE 算总字节、跳过/截断都补差额）+ 宿主 `import_progress` 命令 + `ScanPanel` 导入期间 250ms 轮询，显示「正在导入 1/1 · 文件 · 45%」。轮询而非事件：Kotlin → Rust 没有回调通道（GOTCHAS §69）。真机导入 1.3 GB：16 个不同快照、bytesDone 194MB→1.32GB、结束 bytesDone==bytesTotal；导入后曲库 4→5、清理副本回到 1。smoke 566 | [本轮](#本轮目标第一百三十六轮) |
| R135 | R110 遗留：把「上游返回的不是音频」变成用户能看懂的话 | 新命令 `playback.diagnose{ref}` 读回环代理按字节下的判定（`audio` / `notAudio` / `unknown`；非 2xx 与认不出的封装不下结论，新 `playback.resolve` 清旧判定）；前端只在 `markUnplayable` 判死分支问一次，`notAudio` 就把失败类型换成新的 `notAudio`，文案「音源返回的不是音频（错误页 / 需要登录 / 链接已失效）」。cargo +5 断言、smoke **562**、契约 76 命令；无真机视觉复核（需要真的坏上游） | [本轮](#本轮目标第一百三十五轮) |

## 历史轮次

- R01–R83：[`archive/rounds/R01-R83.md`](archive/rounds/R01-R83.md)
- R84–R88：[`archive/rounds/R84-R88.md`](archive/rounds/R84-R88.md)
- R89–R100：[`archive/rounds/R89-R100.md`](archive/rounds/R89-R100.md)（宠物从 M0 到 1.0 的全过程；R99/R100 为摘要）
- R101–R117：[`archive/rounds/R101-R117.md`](archive/rounds/R101-R117.md)（桌面收尾 + 宠物 1.0 + 安卓 P0–P4 共 17 轮正文）
- R118–R133：[`archive/rounds/R118-R133.md`](archive/rounds/R118-R133.md)（安卓 P3 余项 + 用户 10 条体验反馈的收口批次：手势、歌词页、桌面专有项、背景与重影、过渡）

默认不需要读；查「当时为什么这么做 / 试过什么 / 证据文件叫什么」时再打开。轮次正文只写「当前轮 + 最近三轮」，
更早的每三轮迁一次档——STATE 的预算是 250 token，不要退化成日记。

## 仍然有效的坑

完整条目与验证口径见 [`docs/GOTCHAS.md`](GOTCHAS.md)；先记住这几条：

- 无边框窗口 `decorations:false + shadow:true` 会留 8px 空洞；主窗口必须 `shadow:false`（R70）。
- Tauri 事件名只能字母数字与 `- / : _`；点号会让事件整条丢失（R27）。
- 演示源只在浏览器预览注册；核心在却读失败时返回空，不能拿 mock 冒充（R53）。
- 播放失败必须停表 + 写 `playbackError` + 显示原因，不能只置 `playable:false`（R71）。
- 网易云 803 可能只回游客令牌 `MUSIC_A_T`；只有 `MUSIC_U` 才是登录态（R81/R82）。
- 皮肤删除旧 token 会让旧皮肤整份导入失败；退役键要有界接受并丢弃（R84）。
- 迷你播放器只把 `data-tauri-drag-region` 放顶栏；铺满整页会让 SeekBar 拖拽变成拖窗口（R84）。
- 插件/皮肤列表刷新要走 `plugin.reload()`（`load()` 有 `loaded` 守卫），并且 `invalidateCoreSources()`（R87）。
- 皮肤里新增**顶层字段**必须同时加进核心的 `META_FIELDS`，否则整份 `skin.invalid_document`（R87）。
- 异步「按选中项取列表」必须带请求代号：旧响应晚到会盖掉新内容（R87）。
- 回环流代理 token 只有 30 分钟；媒体元素进 error 态后 `load()` 必须重来，恢复要重新问核心要地址（R87）。
- 数据目录迁移要**逐库**校验（`*.db` 都要 `quick_check`）、旁挂文件按**后缀**跳过且递归生效（R89）。
- 宠物图集必须**带透明通道**；白底 sprite sheet 直接当图集会渲染成一个白方块（R93）。
- Windows 上解 webp 只有 Chromium 可信（GDI+ 不支持、WIC 解 `VP8L` 会出黑底彩条），先截图转 PNG 再处理（R93）。
- 新增窗口必须在 `capabilities/default.json` 的 `windows` 里登记：否则 `listen/emit` 与窗口 API **静默全拒**，
  表现是「窗口开着、一片空白、也不 tick」（R94）。
- 窗口间事件**不排队**：晚起的窗口会漏掉第一次推送 → 要 ready 握手 + 心跳兜底（R94）。
- 像素画按非整数比例缩放会出现**黑色颗粒/毛边**：整数倍缩放 + `image-rendering: pixelated` + 偏移取整（R95）。
- 通知面板 / 锁屏这类**系统界面**只能 `adb exec-out screencap -p` 截；CDP 的 `shot` 只有 WebView 画面。
  `dumpsys media_session` 里 `description` 的第三项是 **ALBUM**（恒为 null），不能拿它判断字幕写没写进去（R116）。
- 通知/锁屏的进度靠 `PlaybackState`：时长是**异步到手**的（必须进 effect 依赖）、暂停时速度必须是 `0f`、
  恢复曲目时元素会先报 0 再跳到续播点（大跨度跳变也要算跳变）（R117）。
- SAF 的类型过滤会把「系统不认识的音频封装」灰掉（`.m4s` 就是）；自己按扩展名筛，且名单要与核心一致（R118）。
- 「点了没反应」先 `document.elementFromPoint(x, y)` 看到底命中谁：扩大的触屏热区会抢走相邻控件的点击；
  `position: absolute; inset: 0` 的覆盖层也不会继承父级的 `padding-top` 让位（R120，GOTCHAS §64）。
- 浮层遮罩这类「谁在动」的验收别靠截图：CDP `CSS.forcePseudoState` 强制 `:active` 读 computed，
  再用 `document.getAnimations()` 数「浮层外还剩几条」。**同权重的 `:active` 规则平局靠源码顺序**，
  压不住就提特异性（挂 `html` 或写进那条被压的规则旁边）（R134，GOTCHAS §68）。

## 下一步（按评估结论继续）

1. **移动端已收口（R120）**：P0–P4 全部落地并真机验证，9 个路由走查无溢出/无报错。
   **用户 10 条体验反馈也在 R134 全部落地**（#1 只剩左边缘横滑这一负结果，见 GOTCHAS §67）。
   剩下的余项见 [`ANDROID-PLAN.md`](ANDROID-PLAN.md) §8 收尾清单（`ACTION_SEEK_TO`、`POST_NOTIFICATIONS`、
   音乐目录导出）——导入进度条已在 R136 收掉。
2. ~~**R110 留下的小任务**：把「上游返回的不是音频」变成用户能看懂的文案~~ → **R135 已落地**
   （`playback.diagnose` + 新的 `notAudio` 失败类型；判定在核心、文案在前端，GOTCHAS §56 的补充）。
3. **宠物 M4 / 玩法打磨（随时可做、可暂缓）**：移动端渲染器（核心层已独立，见 ADR 0010）；`minPetCoreVersion`
   真版本比较、atlas 瘦身（1.5 MB）、走路避让窗口/任务栏、多宠物 UI（存储与 API 已预留）、逐像素 alpha 命中。
   触发条件是安卓决定做宠物。
4. **工程债**：`GOTCHAS.md` 69 条按域拆分（现在是一份长表，查起来靠搜索）；截图证据改成「seeded 数据 + 可深链 +
   固定浅/深基线」，不再靠手算坐标（真机这半已由 `scripts/android-cdp.mjs` 解决）；拖动/悬停这类**注入式输入
   验证不了**的交互，补一份人工验收清单。
5. 背景 P2（带 JS / 多文件网页壁纸）与迷你歌词视觉细调仍挂着，未排期。
