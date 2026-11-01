---
status: active
last_verified: 2026-11-01
owner: gently
scope: 当前迭代状态与下一步
token_budget: 250
tldr: 当前 R112（P2-1 前台服务落地）：按 R111 的实测结论，把「保活」做出来了 —— Kotlin `PlaybackService`（前台服务 + `gently-playback` 通知渠道 + 常驻通知）经 `PlaybackPlugin`（`@TauriPlugin`/`@Command`）由 Rust 的 `register_android_plugin` + `run_mobile_plugin` 驱动，宿主新增命令 `playback_banner`，前端 `services/playbackBanner.service.ts` 只在「在播/停/换歌」时推一次（不跟随进度，Kotlin 不读位置、不计时）。真机验证：`dumpsys activity services` 看到 `isForeground=true foregroundId=1001`；**熄屏 4 分钟后进度 5/271 → 258/271（+253 秒）**（R111 同一测量是停住/僵死/整页重载）；HOME 后台 1 分钟 `4 → 68`；曲目放完服务自动退出。smoke 528 → **529**。
---

# STATE

## 本轮目标（第一百一十二轮）

> 起点：R111 把 P2 的路线测清楚了（WebView 播放 + 前台服务保活），
> 本轮把这条路线的最小可用版**做出来并在真机证明它有效**。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| Kotlin（`src-tauri/gen/android/app/src/main/java/com/xun/gently/`） | 新增 `PlaybackService.kt`：前台服务 + `gently-playback` 渠道（IMPORTANCE_LOW）+ 常驻通知（标题/歌手、`category=transport`、`setOngoing`、点一下回应用）；`onStartCommand` 里立刻 `startForeground`（5 秒硬限），停止指令直接退出。新增 `PlaybackPlugin.kt`：`@TauriPlugin` + `@InvokeArg` 参数 + `@Command fun update`，按 `active` 起/停服务，异常 `invoke.reject` |
| 清单 | 三条权限（`FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_MEDIA_PLAYBACK` / `POST_NOTIFICATIONS`）+ `<service android:name=".PlaybackService" android:foregroundServiceType="mediaPlayback" android:exported="false"/>`。`targetSdk = 36`：缺 `FOREGROUND_SERVICE_MEDIA_PLAYBACK` 在 API 34+ 会 `SecurityException` |
| Rust 宿主 | 新增 `src-tauri/src/playback.rs`：`tauri::plugin::Builder::new("gently-playback")` + `register_android_plugin("com.xun.gently","PlaybackPlugin")` + `run_mobile_plugin("update", …)`；非 Android 是空插件/空操作。`lib.rs` 注册插件与宿主命令 `playback_banner(active,title,artist)` |
| 前端 | 新增 `services/playbackBanner.service.ts`：只在「在播 / 停 / 换歌」时推一次（同一状态去重），没有宿主时**静默空操作**；`useAudioEngine` 订阅 `playing + 标题/歌手` 调它。播放状态仍以 store 为唯一权威 |
| 文档 | `ARCHITECTURE.md` §12 补「播放通知 / 前台服务」这条宿主边界；`ANDROID-PLAN.md` §7.5 落地记录 + 拆分表加 P2-1/P2-2；`GOTCHAS.md` §58（原生代码在 `gen/android`、Rust↔Kotlin 只有命令方向、前台服务两道硬门槛、怎么验） |

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**529**（528 → +1「没有宿主时静默空操作」）；
- **真机（`CDY-AN00`，arm64 debug 包）**：

  | 项 | 结果 |
  |---|---|
  | 服务真的在前台 | `dumpsys activity services`：`ServiceRecord{… com.xun.gently/.PlaybackService}` + `isForeground=true foregroundId=1001 foregroundNoti=Notification(channel=gently-playback … category=transport vis=PUBLIC)` |
  | 通知内容 | `r112-android-notification.png`：通知栏里 `▷ gently / probe`；`dumpsys notification`：`icon=android:drawable/ic_media_play`、`contentIntent=… startActivity` |
  | **熄屏 4 分钟** | `5/271` → **`258/271`**（≈ +253 秒）；截图 `r112-android-lockscreen.png`（进度条几乎填满、拇指在右端）。**R111 同一测量是停住/僵死/整页重载** |
  | HOME 后台 1 分钟 | `4/271` → `68/271`（+64 秒），回前台进度对得上 |
  | 收尾 | 曲目放完后 `dumpsys activity services` 里已无 `PlaybackService`，进度归 `0`（停播即退出，不常驻） |

### 3. 未做 / 值得你知道的

- **通知上没有播放/暂停按钮**（P2-2）：加传输控制要 `MediaSession` + `PendingIntent` 回服务，
  再经 `Plugin.trigger`/`Channel` 回到前端 store——**播放状态必须回 store 才算数**，不能只有通知在变；
- 通知小图标暂用系统的 `android.R.drawable.ic_media_play`（P2-2 换应用自己的）；
- `POST_NOTIFICATIONS` 还没有运行时授权入口（API 33+ 不授权时通知不可见，但保活仍生效）；
- 安卓原生改动不进 `pnpm verify`，只能靠 `tauri android build` + 真机（已在 GOTCHAS §58 写明）；
- 「上游返回的不是音频」仍只进日志（R110 记的候选任务）；SAF 导入（P3）、通知栏歌词（P4）未动。

## 本轮目标（第一百一十一轮）

> 起点：R110 把「播不出声」定案成上游问题。剩下的真问题是 P2——
> 但计划里 P2 的入口条件写得很清楚：**先实测，再选路线**。本轮先测，再修测出来的 bug。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| 实测（P2 入口条件） | 真机（`CDY-AN00`）播放 271 秒本地曲目 → 熄屏 → 定时用 `android-cdp.mjs eval` 读 `[role=slider]` 的 `aria-valuenow`。**三个包测出三种形态**：① R110 包：`4`→`33`→`171`，解锁回前台仍 `171`（音频停住）；② R111 首包：`4`→`56`→`226`，解锁后仍 `226`，元素 **`paused === false`** 也没报错（位置不动 = 僵死）；③ R111 带僵死看门狗：解锁回前台**进度是 `0`**——页面被系统整页重载，播放状态全丢。三种都不是进程死亡（`pidof` 一直没变） |
| 结论 | **P2 必须做前台服务（foreground service）+ MediaSession**，技术路线「WebView 播放 + 保活」；另有一条新发现：**页面被重载后播放状态全丢**，P2 落地时要持久化「上次在放什么 / 放到哪」并恢复 |
| 根因（第二层） | 形态 1 里 `HTMLMediaElement.play()` 返回的 Promise **既不 resolve 也不 reject**（探针挂到 CDP 超时都没回来）；旧代码 `await el.play()` 永远停在那一步，看门狗拿不到结论——不重载、不换源、不停表 |
| 前端（`audio.service.ts`） | 新增 `tryPlay()`：`play()` 一律带 **3 秒上限**（`ok / rejected / timeout`）；`resume()` 同套、超时算 `failed`；新增 `hardRecover()`（**先 reload 再 play**，治「以为在播、位置不动」）；`timeupdate` 里维护「位置采样」 |
| 前端（`utils/playbackStall.ts`） | 新增纯函数 `isStalled(previous, position, now, threshold)`：**只判 `paused` 会漏掉形态 2**，所以按「位置 8 秒没变」判僵死（正常缓冲抖动被阈值滤掉；倒退/前进都算在动） |
| 前端（`useAudioEngine.ts`） | 看门狗两条路：`isPausedNow()` → `resume()`；`isStalledNow()` → `hardRecover()`。都以「有 `MediaError` 给 2 次重新解析、只有超时/僵死给 1 次」收尾，仍不行 `markInterrupted()` |
| store / 文案 | 新增 `player.markInterrupted()`（**只停表、不换源**，曲目与候选都留着）、`PlaybackFailure.kind` 增加 `'interrupted'`、`playbackFailureText()` 三路分支、`player.failureInterrupted` 中英文案（「播放被系统中断（点播放继续）」）。点播放走既有 `retryPlayback` |
| 测试 | 冒烟 +3：`isStalled` 边界（动了/倒退/首次采样都不算）；三种失败各有文案且 `interrupted ≠ media`；`markInterrupted` 停表 + 写原因 + **曲目还在**（用例前后保存/复原 player 切片，不污染后面依赖候选列表的渲染用例） |

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**528**（525 → +3，全绿）；`pnpm verify` 8 道全绿；
- 真机三种形态的时间点与读数已逐条记进 `ANDROID-PLAN.md` §7.4（含 `pidof`、`ActivityRecord` 证据）；
- **诚实边界**：形态 3（页面被系统重载）下恢复逻辑没有机会执行——本轮的修复覆盖的是「页面还活着」的形态 1/2；
  让播放真正活下来要靠 P2 的前台服务。所以本轮的验证是「smoke 钉死逻辑 + 真机钉死现象」，不是「真机证明已修复」。

### 3. 未做 / 值得你知道的

- **P2 本体（前台服务 + MediaSession + 通知栏控制）还没做**：下一步在 `gen/android` 里加 Kotlin
  `Service` + 通知 + MediaSession，用 Tauri 的 `register_android_plugin()` 桥接（`run_mobile_plugin`），
  前端只在播放状态变化时推一次；这需要新增 Android 侧代码与 Gradle 配置；
- **播放状态持久化**（形态 3 暴露的）：页面被重载后要能恢复「上次在放什么 / 放到哪 / 暂停态」；
- 通知栏歌词（P4）依赖 P2 的前台服务；SAF 导入（P3）需要原生文件选择器；
- 「上游返回的不是音频」仍只进日志（R110 记的候选任务）。

## 本轮目标（第一百一十轮）

> 起点：R109 收尾还剩一句「安卓仍然放不出声（风险 11，未解）」。
> 那句话在 R108 就挂上了，两轮都被写成「解码 / Content-Type 问题」——
> 本轮先用工具把「到底哪一环坏了」分开，再动手。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| 诊断工具 | 新增 `scripts/android-cdp.mjs`：走 WebView devtools socket（debug 包自带），`ping`（顺带打印页面 URL）/`eval`/`tap --text`/`shot`/`net`。以后真机排查**不用 `adb input tap` 手算坐标**（R108/R109 各为此浪费过一轮） |
| 定位 | ① `fetch('http://127.0.0.1:<port>/m/<token>')` → `{ok:true, type:'opaque'}`：网络与字节都通；② `new Audio(同 URL)` → `error.code=4`；③ 代理日志（本轮新加）显示 `content_type="text/html;charset=utf8" sniffed="(unknown)"`；④ 把响应体取出读：**网易云「网页找不到」页**（102 752 字节、HTTP 200）。→ 不是解码问题，是上游拿错误页冒充音频 |
| 核心（`core/src/media.rs`） | ① `Content-Type` 优先级改成 **字节嗅探 → 插件 `mimeType` → 上游类型 → 扩展名**；② 媒体元素惯用的 `Range: bytes=0-` **也嗅探**（`range_starts_at_zero`；不这么做的话这层修复在真实路径上等于没做）；③ 嗅探用掉的字节用 `Cursor.chain` 原样回吐（少一个字节都会坏）；④ `publish()` 多一个 `mime` 参数，插件声明的 `mimeType` 不再被丢掉；⑤ 远端 + 本地两条代理都补 `Access-Control-Allow-Origin: *`；⑥ 响应日志补 `status / content_type / upstream_type / sniffed / prefix_len`，认出不是音频再记一条 WARN |
| 契约侧 | 命令/事件**零变更**（`playback.resolve` 的 `mimeType` 本来就在契约里，只是以前没被用起来） |
| 测试 | 核心新增 4 项：嗅探各类容器、插件声明类型优先于「上游 octet-stream」、`bytes=0-` 仍可嗅探、**端到端**（假上游给 `application/octet-stream` + fMP4、客户端带 `Range: bytes=0-` → 回 `audio/mp4` 且字节一个不少）；核心单测 82 → **84** |

### 2. 验证

- `cargo test -p gently-core --offline`：**84 passed**；`pnpm verify`：**8 道全绿**；
- **真机播放链路（与上游无关的那半）**：`adb push` 一份 `src/assets/yihuik苡慧 - 致你.m4s` 到应用私有目录 →
  「本地音乐 → 扫描本地目录」扫到 1 个 → 点播放：

  | 证据 | 内容 |
  |---|---|
  | 核心日志 | `媒体响应（本地文件） status=206 start=0 end=4388383 total=4388383 has_range=true` |
  | DOM（`aria-valuenow/max`） | **5/271 → 13/271**（间隔 8 秒）→ WebView 真的在解码播放 |
  | 截图 | `r110-android-local-list.png`（扫描面板 + 扫到的曲目）、`r110-android-local-playing.png`（播放中，进度条有焦点与填充） |

- 顺带排除了两条猜想：页面 origin 是 `http://tauri.localhost`（**不是 https**，所以不是混合内容拦截）；
  `validate_origin` / 代理链路都正常（`媒体连接已接受` + 206）。
- **诚实结论**：用户导入的两个社区源（`bili-audio` / `wangyiyun`）此刻取到的媒体地址都只回错误页，
  所以「点歌放不出声」在他们的环境下**还会发生**——但那是上游/登录态问题，App 侧已经不再是黑盒。

### 3. 未做 / 值得你知道的

- 「上游返回的不是音频」目前只进**日志**，界面仍显示「无法播放 / 重试 / 换源」。要变成用户能看懂的文案，
  得在 `playback.resolve` 里先探一次（顺带自动换下一个候选）或加一条契约事件——下一轮的候选任务；
- 嗅探只覆盖常见音频容器；`.m3u8` 这类播放列表仍是「上游给什么类型就用什么」；
- 面板/抽屉等移动端交互本轮没动；P2（后台播放）仍在等「锁屏 5 分钟 WebView `<audio>` 还活着吗」的实测。

## 本轮目标（第一百零九轮）

> 起点：R108 把手机外壳（抽屉 + 搜索 home + 常驻播放条）落到真机，留下 P1-4/5/6 三片。
> 用户的说法是「先读 `public/` 下那两个 skill，然后把移动端做完」——
> 读的是 `public/skills/polished-ui-skills`（`polished-ui-design` 的 mobile-layout /
> mobile-navigation / touch-interactions / android-patterns / mobile-audit / mobile-accessibility）
> 与 `public/skills/skills`（`design/visual-design-principles`、`design-system-as-input-ui`）。
> 两条直接用了：**触控尺寸别缩**（视觉可以小、命中区 44px）、**密集信息用 bottom sheet 渐进披露**。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| 列表（P1-5） | `table.config.tsx` 新增 `mobileColumns(options)` / `mobileTrackColumns(t, options)`：手机 3 列 = `主信息(1fr) + 时长 + ⋯`，两行式（标题 / 歌手·附加·专辑）。`DataTable` 新增 `mobileColumns` 属性，用**纯函数** `resolveColumns(shell, columns, mobileColumns)` 裁决——只有 `mobile` 形态才换；视图一次都不写 `@media`。9 个列表全部接上：搜索 / 本地 / 最近 / 收藏 /（源收藏）/ 歌单 / 专辑详情 / 下载中 / 已下载 / 插件 |
| 行操作（P1-4） | 新模块 `components/ui/row-actions`：`MobileRowActions`（行尾 ⋯，44px）+ `RowActionsProvider`（底部面板：抓手 + 标题 + 48px 一行动作）。动作**与桌面同一批**（`useTrackActions` 不变）。没有宿主时（桌面 / 冒烟）自动退回行内按钮，不留「点了没反应」的入口 |
| 面板宿主 | 挂在 `MobileShell` **外层**（包住 shell）：面板要盖满屏幕，放进带 `backdrop-filter` 的容器里会被当成包含块（GOTCHAS §54）。关闭走**根 div 的 onClick**（面板自己 `stopPropagation`），不依赖透明 `<button>` 的命中区（§55） |
| 抽屉 | 真机上「点遮罩关闭」不可靠（透明 button 不收点击，§55）：关闭动作挂到根 div，并补一个显式 **✕**（`mobile.close`）——三条关闭路：点遮罩 / 点 ✕ / 选中一项 |
| SeekBar | `:global([data-shell='mobile'])` 下焦点常显、热区 32px（`--mobile-progress-hit-height`，只往条内扩，不抢列表最后一行的点击）；触屏松手清掉时间预览（没有 `pointerleave`） |
| 窗口能力（P1-6） | `window.service.ts` 新增 `desktopWindowActionsAvailable(tauri, mobile)`：`minimize / toggleMaximize / setAlwaysOnTop / setCompact / restoreFromMini` 在移动端 no-op，`isMaximized / isAlwaysOnTop / onResized` 如实返回「没有这个能力」，不再打出假故障日志。桌面歌词桥本就有 `isMobilePlatform()` 早退，宠物桥由 App 按形态开关 |
| 主题 | `components.mobile` 补 9 个度量（两行式封面 / 行内边距 / 从属列宽 / ⋯ 触控尺寸 / 进度条热区 / 面板内边距·最大高度·抓手）；新增语义色 **`modalScrim`**（明暗都压暗）与 `--modal-scrim`，`ConfirmDialog` 那唯一一处字面 `rgba` 也换成它 |
| 文档 | `ANDROID-PLAN.md` §7.1 进度表 + 新增 §7.2「R109 落地说明」；GOTCHAS §53（手机列表别压窄）、§54（`backdrop-filter` 抢包含块）、§55（**button 当遮罩不涂背景**） |

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**525**（509 → +16，全绿）；`pnpm verify`：**8 道全绿**
  （类型 / 冒烟 / 契约 / 可达性 / 核心单测 / 宠物独立性 / 宠物核心单测 / 宿主单测）；
- **顺带修掉一条长期红的测试**：`pet-core/tests/atlas.rs` 的 `shipped_pet_package_validates_and_installs`
  断言「第 N 个动画必须落在第 N 行」，而仓库里的内置包把「往左跑」贴在第 2 行、按语义先声明它
  → 这条断言与包**一直**不一致（`pets/` 没动过，本轮跑 verify 才发现）。改成守真正要守的东西：
  9 个动作**不重不漏**占满 9 行 + `idle=0 / runRight=1 / runLeft=2` 这三条素材事实；
- 新增断言（都钉在「会悄悄回归」的地方）：手机列只有 3 列且桌面 7 列 key 序列不变、
  `resolveColumns` 四形态裁决、没有宿主时退回行内按钮、有宿主时行内只剩一个 ⋯（动作不在 DOM 里）、
  模态遮罩两种方案都是 `rgba(0, 0, 0, 0.45)`、手机进度条焦点常显 + 热区 ≥ 24px、
  **移动播放条 `.bar` 必须有 `position: relative`**（R109 真机踩到的坑）；
- 真机（`CDY-AN00` · Android 10 · arm64）`android build --debug -t aarch64 --apk` 装机后走了一遍：

  | 文件 | 内容 |
  |---|---|
  | `r109-android-home.png` | 搜索作 home：`搜索结果 /「」共 0 首` + 音源 chips + 常驻播放条空态 |
  | `r109-android-drawer.png` | 抽屉 8 项（搜索高亮），**内容被压暗**（之前是白底看不见遮罩） |
  | `r109-android-search-list.png` | `love` 共 39 首：两行式行（封面 + 标题 + 「歌手 · N 个音源 · 专辑」），右侧 `4:15` 与 ⋯ **完整不裁** |
  | `r109-android-actions-sheet.png` | 点 ⋯ → 底部面板「Love / 播放 / 收藏 / 下载」，背景压暗 |
  | `r109-android-playing.png` | 行高亮（品牌色 + 左侧指示条），播放条 `Love / Keyshia Cole` |
  | `r109-android-seek.png` | 进度条在**播放条顶边**，触屏常显焦点（修复后重截） |
  | `r109-android-nowplaying.png` | 播放条 → 歌词页（手机默认省封面，歌词占满） |
  | `r109-desktop-search.png` | 桌面回归：7 列（# / 标题 / 歌手 / 专辑 / 时长 / 来源 / 操作）+ 行内按钮，一点没变 |

- 三个**只在真机上出现**的问题都是本轮实测发现的（不是推出来的），处理方式记在 GOTCHAS：
  ① 时长 `4:18` 被单元格 18px 内边距挤成 `4…`、⋯ 被裁成两个点 → 手机单元格留白收到 8px；
  ② 遮罩色画在 `<button>` 上真机不涂 → 颜色改画在容器 `<div>` 上（抽屉 + 面板都改了）；
  ③ `MobilePlayerBar` 的 `.bar` 缺 `position: relative` → `SeekBar` 的 `top: 0` 一直锚在**整个应用顶边**
     （关掉动态背景时 `--surface-blur: none`，没有任何祖先能当包含块）。

### 3. 未做 / 值得你知道的

- **音频解码失败仍未解**（`ANDROID-PLAN.md` 风险 11，P2 的前置问题）：这轮 UI 走查里点播放能在
  「模拟时钟」下推进进度、切歌、进歌词页，但真实音频仍是 `DEMUXER_ERROR_COULD_NOT_OPEN`；
- 平板横屏专用布局没做（仍按 `mobile` 单栏走）；`compact` 那三档只在桌面生效；
- 手机列表的「下载标记」挤在标题行尾部（信息密度换来的取舍），若要更清爽可以挪进 ⋯ 面板；
- 面板是「点遮罩关闭」，没有做下滑手势（避免与系统手势冲突，也避免自造一套手势语义）。

## 第一百零六轮

> 起点：用户说「继续完善 petcore」。翻了一遍 `pet-core` 的面，最该修的不是加功能，
> 而是**三处「字段/条件写了但不生效」**——那种东西比没有更坏：文档说支持，实际不按它办事。
> 顺手把宠物域的错误码做成和音乐域一样「有本地化文案、有守卫」。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| 版本（真比较） | 新增 `pet-core/src/version.rs`（自己解析 `x.y.z`，不引依赖）：`version` 必须能解析，`minPetCoreVersion` 与本机核心比较，**高于核心就拒绝安装** → 新错误码 `pet.incompatible`。`PET_CORE_VERSION` 之前定义了却没人用，现在有用了 |
| 静默（真计时） | `Sim` 记 `silent_ms`：只有「没在播」的时间才累加，恢复播放立刻归零；`Condition::SilentFor{ms}` 据此判断（`ms = 0` 等价于「一停播就算」）。以前它只是 `!playing`，写 3 秒也等于 0 |
| 反应动画（演完一遍） | `interrupt` 切换后记 `reaction_hold_until = clock + clamp(frames×frameMs, 200, 2000)`，这段时间状态机不接管画面。没有它，R105 的 160ms 确认期会把 `jump` / `inspect` 在 160ms 后掐掉（点了只抖一下） |
| 体积 | `pet.json` 原文上限 **512 KiB**（`MAX_SPEC_BYTES`，落库前检查）；图集仍是 8 MiB |
| 可观测 | `pet.state` 新增 `coreVersion`；调试面板加「宠物核心」行（`1.0.0 · 包要求 ≥ 1.0.0`） |
| 错误文案 | 7 个 `pet.*` 错误码全部加 zh/en（`errors.pet_*`）；`pet-card` 改用 `errorText()`，不再把中文开发者说明直接显示给用户；新增 smoke 守卫「宠物错误码也有 zh/en 文案」 |
| 内置包 | 升到 **1.0.4**，`minPetCoreVersion` 从 `0.1.0` 改成 `1.0.0`（它现在真的用了 `fit` / `interrupt`），并加一条测试当保险丝：内置包要求的版本必须 ≤ 当前核心 |

### 2. 验证

- `cargo test -p pet-core`：**72 passed**（58 → 72：`version.rs` 6 项 + `silence.rs` 3 项 + lib 里 5 项版本单测）；
  `cargo test -p gently`：**5 passed**；`pnpm smoke`：**509**；`pnpm verify`：**8 道全绿**；
- 新版测试直接对着三个缺口写：
  - `a_package_that_needs_a_newer_core_is_rejected`（错误信息里带要求版本）、
    `a_package_that_asks_for_an_older_core_installs`、`version_must_look_like_a_semantic_version`、
    `an_oversized_spec_is_rejected_before_parsing`、`state_reports_the_core_version`；
  - `silence_has_to_last_long_enough`（2.5 秒不打哈欠，3.0 秒才打）、
    `resuming_playback_resets_the_silence_clock`、`zero_milliseconds_means_immediately_when_silent`；
- 打包版实图 `r106-pet-debug.png`：调试面板多出「宠物核心 1.0.0 · 包要求 ≥ 1.0.0」一行。

### 3. 未做 / 值得你知道的

- 版本比较**不处理预发布排序**（`1.0.0-rc1` 与 `1.0.0` 视为同版本）——宠物包不需要这套语义，
  真需要时再补，别自己发明排序；
- `fit` 还是按整行缩放（不按帧）；`SilentFor` 依赖宿主如实给 `playing`；
- 走动 / 看鼠标 / 自动穿透仍只在 Windows；
- 安卓仍按用户决定延后。
## 第一百零五轮

> 起点：用户报三条 —— ① 仍然像在拖「窗口边框」，而且**以后加拖动动画也没处放**；
> ② 切动画时模型会突然变大（部分行动画偏大、部分偏小）；
> ③ 走动中动画会「跑 → 待机 → 跑」闪一下。
> 三条都在「渲染层 / 动画调度」这一层，所以一起改。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| 拖动（根因） | 换成**渲染器自己搬窗口**：`pointerdown` 记住屏幕坐标与该时刻窗口位置，`pointermove` 里按屏幕坐标差 × `devicePixelRatio` 调 `setPosition(PhysicalPosition)`（`requestAnimationFrame` 合并，一帧最多一次 IPC）。不用系统 `startDragging()` 的原因：它把事件循环交出去，JS 不跑、画面冻住，**拖动动画根本没法加** |
| 拖动（表现） | 「开始拖」后立刻演 `jump` 那一行（四肢张开 = 被拎起来），松手回到核心给的状态；`gently:pet:dragging` 期间宿主不切穿透、不走动；窗口位置保存改成 250ms 防抖（拖动时 `onMoved` 一秒几十次） |
| 尺寸（数据） | `pet.json` 新增 `animations[].fit{scale,offsetX,offsetY}`：整行等比缩放 + 底部对齐，盒子取所有行最大的那一格（放大不裁切）。内置包实测填 0.8–1.08（「跑」原来比待机高 19%、「失败/等待」是头部特写） |
| 尺寸（渲染） | 背景改挂到**格子大小**的 `.spriteLayer` 上、盒子 `overflow: hidden`：不然盒子大于格子时会露出图集里相邻格子的像素（实测右侧多出半个身子）；`lookRows` 不参与 `fit`（同一张脸不能忽大忽小） |
| 衔接（核心） | 状态类动画每拍**独立**算「应该是什么」（忽略行为冷却——靠重复触发计时会被冷却挡掉），同一目标连续满 **160ms** 才切；`play` 新增 `"interrupt": true`（点击 / 换歌）当拍就切 |
| 衔接（宿主） | 走动暂停加迟滞：光标**连续 10 拍（≈0.6s）**都在宠物身上才停，擦一下不再让走动中断 |
| 测试 | `pet-core/tests/transition.rs` **5 项**（单拍抖动不切、持续状态按确认期切、抖动不重置确认期、`interrupt` 当拍生效、切动画帧游标归零）；`pet-core/tests/fit.rs` **4 项**（fit 原样往返、缩放范围、偏移上限、缺省中性）；smoke +5（盒子/锚点/每行缩放/无 fit 不变/look 不受 fit 影响）；smoke **503 → 508** |

### 2. 验证

- `cargo test -p pet-core`：**58 passed**（49 + 5 transition + 4 fit）；`cargo test -p gently`：**5 passed**；`pnpm smoke`：**508**；`pnpm verify`：**8 道全绿**；
- **拖动（这次真的自动化验到了）**：注入式鼠标事件（`SetCursorPos` + `mouse_event`）把指针从右下拉到左上，
  窗口位置**逐帧 1:1 跟随**（每 3 步 -30,-18 → 窗口也是 -30,-18；全程 dx=-148 / dy=-72 含摆放补偿），
  松手后停在原地。截图 `r105-pet-idle.png` / `r105-pet-dragging.png` / `r105-pet-dropped.png`；
- **尺寸归一**：`r105-animation-fit.png` 是用 `pet.json` + 真实图集按**同一套布局算式**渲染的九宫格
  （idle 1 / runLeft 0.8 / runRight 0.8 / wave 1 / jump 0.9 / fail 0.8 / wait 0.84 / run 1.08 / inspect 0.82），
  除两行头部特写外角色高度一致；
- **走动时的动画**：`r105-pet-walk-0..7.png`（走动中连续 8 帧，跑动行不再比待机大一圈）；
- 设置页预览缩略图仍正常（`r105-pet-card.png`，`Gently 小助 v1.0.3`）。

### 3. 未做 / 值得你知道的

- **两条必须如实说的**：
  1. 「失败 / 等待」两行素材本身就是**头部特写**（不是全身），`fit` 只能让「头」一样大——观感仍是「凑近脸」，
     要是你觉得别扭，我可以把这两条行为改成全身动作（`wave` / `inspect`），但那就丢了哭泣/等待的表情；
  2. 拖动动画临时用 `jump` 那一行（现有 9 个动作里最像「被拎起来」的），换更贴切的素材后只需要改一个常量；
- `fit` 是按**整行**缩放（不按帧），所以行内各帧的细微比例差还在；要更细就得给每帧单独的数据；
- 走动 / 看鼠标 / 自动穿透仍只在 Windows；
- 安卓仍按用户决定延后。
## 第一百零四轮

> 起点：R103 收尾时留下两处「没验证到的地方」——拖动的真实手感只能人工确认、
> 调试面板的「探测一帧」没能点中。本轮按「先把能自己验证的验证掉」推进：
> 把拖动的**结构性隐患**修掉，把调试面板做成**打开就自带数据**。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| 拖动（真凶） | 宿主每 60ms 按「光标是否在精灵矩形内」决定穿透；系统拖动时窗口位置更新滞后于光标，拖动头几十毫秒里光标已经出了矩形 → 窗口被切成 `ignore_cursor_events(true)` → 后续 `pointermove` 到不了 webview，拖动断在中间（用户感觉「拖不动 / 拖一半卡住」）。现在前端判定「开始拖」就先发 `gently:pet:dragging {dragging:true}`，`startDragging()` 返回后（或窗口失焦）发 `false`；宿主 `poll_once` 在 `DRAGGING` 期间**直接 return**（不切穿透、不自己走动） |
| 拖动（补收尾） | `startDragging()` 之后 `pointerup` 常常收不到，所以另加 `window blur` 兜底再发一次「没在拖」，避免宿主一直以为在拖（那会让宠物永久失去自动穿透） |
| 调试面板 | 展开面板就**自动读一帧**（`pet.tick{dtMs:0}`），不再要用户先点按钮；帧读数把动画**序号换成名字**（`animation=runRight(2)`，名字从 `pet.state` 的 spec 反查——没有单独的 `pet.get`）；新增「窗口开关」行（点击穿透 / 走动）；`probeOnce` 包了 `try/catch/finally`，**抛异常也显示出来**（调试面板最怕「点了没反应」） |
| 测试 | smoke 新增 1 项：宠物窗口 6 个事件名（含新的 `gently:pet:dragging`）都在 Tauri 接受的字符集内（GOTCHAS §31 那类「带点号事件整条丢失」的守卫）；smoke **502 → 503** |
| 测试抖动 | `oauth` 测试偶发 `连接本机回调端口` panic（回调监听线程绑端口是异步的，`begin` 返回后立刻 connect 会失败一次）→ 抽出 `connect_callback()` 最多重试 3 秒，不再用「sleep 一段时间再连」 |
| 文档 | GOTCHAS §39（拖动期间宿主必须停手）、§40（`ui:capture` 跑的是 `release/` 打包版 exe，改完代码要先 `pnpm package:portable`）、§41（回调端口测试要重试）；`pet.md` 调试面板一节补自动读帧与窗口开关 |

### 2. 验证

- `pnpm smoke`：**503**（+1 事件名守卫）；`cargo test -p pet-core`：**49 passed**；`cargo test -p gently`：**5 passed**；`pnpm verify`：**8 道全绿**；
- 打包版实图 `r104-pet-debug.png`（真的走了一遍「开设置 → 滚到宠物卡 → 点展开」）：
  面板自己读出真实数据 —— `出战宠物 gently-mascot` · `宠物窗口 可见 · 1021, 848 · 200×160` ·
  `记住的位置 1021, 848` · `窗口开关 点击穿透=关 · 在屏幕上走动=开` · `图集 atlas.png · 1516 KB` ·
  `最近一帧 animation=runRight(2) frame=7 look=– bubble=– · 14.6ms`
  （`runRight` 正好说明「走动方向 → 动画」那条链路是活的）；
- 「探测一帧」的读数是**自动探测**产生的，不再依赖点按钮——R103 那条「按钮点不中所以没证据」的欠账清掉。

### 3. 未做 / 值得你知道的

- **拖动本身仍只能人工确认**：注入式鼠标事件驱动不了系统窗口拖动（R102 的 A/B 已证明，连主窗口标题栏都拖不动）。
  本轮修的是「拖到一半被宿主掐断」这个结构性隐患，手感需要你拖一下确认；
- 拖动期间宠物**不看鼠标**（`poll_once` 直接 return）：实际观感是拖动时它不转头，这是有意的取舍；
- 走动/看鼠标/自动穿透仍只在 Windows；
- 安卓仍按用户决定延后。
## 第一百零三轮

> 起点：用户提了三条——① 宠物设置的语义与功能不匹配；② 拖动反直觉（像在拖窗口而不是拖宠物）；
> ③ 想要一个开发用的控制面板。
> 目标：把设置项改成和其它设置一致的「单选」、拖动只留「直接拖宠物」这一条路、并给排查用的调试面板。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| 设置语义 | 三处开关（宠物启用 / 点击穿透 / 在屏幕上走动）从「单个按钮、标签是状态」改成**下划线单选组**（`UnderlineRadioGroup`，与「危险操作二次确认」「发现页自动试听」同款）：**高亮的是当前状态，点另一边才是动作**——这就是「语义与功能不匹配」的根子 |
| 拖动 | **删掉顶部那条透明拖动条**（`data-tauri-drag-region`）与它的可交互区域登记：它离宠物很远，拖起来像在拖一个看不见的窗口。现在窗口里唯一可交互的是宠物本体（其余透明区域一律穿透），按住移动 > 5px 开始拖，拖完吞掉那一次 click；并加 `cursor: grab / grabbing` 让「能拖」看得见 |
| 调试面板 | 新增 `views/setting/components/pet-debug.tsx`（默认收起）：「出战宠物 / 宠物窗口（可见性·位置·尺寸）/ 记住的位置 / 图集（文件名·KB）/ 最近一帧（`pet.tick` 探测：animation·frame·look·bubble·往返 ms）」，按钮：探测一帧、喂食、摸一下、重置窗口位置；只读信息分别来自核心、宿主窗口、渲染层，读不到就显示「—」 |
| 文档 | `docs/pet.md` 更新拖动说明 + 新增「调试面板」一节；GOTCHAS §37 补「R103 去掉了拖动条」的结论与新的验证口径 |

### 2. 验证

- `pnpm smoke`：**502**；`cargo test -p pet-core`：**49 passed**；`cargo test -p gently`：**5 passed**；`pnpm verify`：**8 道全绿**；
- 打包版实图：
  | 文件 | 内容 |
  |---|---|
  | `r103-pet-settings.png` | 三处开关都是「启用 / 禁用」单选，高亮项＝当前状态（宠物启用、未锁定、不走动） |
  | `r103-pet-debug.png` | 调试面板展开，显示真实数据：`出战宠物 gently-mascot`、`宠物窗口 可见 · 749,848 · 200×160`、`记住的位置 749,848`、`图集 atlas.png · 1516 KB` |
- 顺带修好的：位置记忆不再被「程序摆放」污染——面板里「窗口位置」与「记住的位置」现在是同一个值；
- 交付物重新生成：`release/gently-0.1.0-windows-x64.zip`（SHA256 `d4383833…79a63a1`）。

### 3. 未做 / 值得你知道的

- **拖动的真实手势仍只能人工确认**：注入式鼠标事件驱动不了系统窗口拖动（R102 已 A/B 验证过，连主窗口标题栏都拖不动），本轮只改了「拖哪里」与「怎么判定」，需要你拖一下看手感；
- 调试面板的「探测一帧」按钮我没能在自动化里点中（设置页坐标要靠截图反推，点空了几次）；`pet.tick{dtMs:0}` 这条路径本身有核心分发测试覆盖，但面板上那行读数的渲染没有截图证据；
- 走动/看鼠标/自动穿透仍只在 Windows；
- 安卓仍按用户决定延后。

## 第一百零二轮

> 起点：用户报「完善走动，其次修复交互事件 bug 如：拖动根本无法生效」。
> 目标：① 让宠物自己走到屏幕上的别处（用上一直没接条件的 `runLeft`/`runRight`）；
> ② 把拖动修好——两件事都出在同一层：**窗口的可交互区域**。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| 根因（拖动） | R100 的自动穿透只把**精灵**登记为可交互区域，顶部拖动条不在里面 → 宿主把整窗设成穿透 → `data-tauri-drag-region` 与 `startDragging()` 都收不到 `pointerdown`。改成**多块矩形**：`src/pet/hit-areas.ts` 统一登记（精灵 + 拖动条）并去重上报，宿主 `inside_any` 任意一块命中就不穿透 |
| 拖动体验 | 宠物本体也能拖：按住移动 > 5px 才判定为拖（`startDragging`），拖完那一次 `click` 吞掉，避免「拖一下顺手摸一把」 |
| 位置记忆 | 修掉「程序摆放被当成用户拖动」：摆放后记 `gently:pet-window-placed`，宠物窗口的 `onMoved` 位置与它相差 ≤2px 就不写记忆（以前会出现宠物随机贴到主窗口旁边的怪位置） |
| 走动（核心） | `Input.walk_dir`（-1/1）→ 新条件 `Condition::Walking{dir}`；`pet.tick` 增加 `walkDir`；内置宠物包升 **1.0.1** 并加两条行为（往左→`runLeft`、往右→`runRight`）；Codex 包的默认行为表同样补上 |
| 走动（宿主） | 同一条 60ms 轮询里加「走动」：每 10–40 秒挑一个屏幕底部的新位置（`current_monitor` 边界内、至少挪 120px），按 4px/60ms 平移窗口，方向变化才发 `gently:pet:walk`；光标在宠物身上时停住，锁定状态照常走 |
| 走动（设置） | 新增「在屏幕上走动」开关（默认**关**，持久化 + 立即同步宿主）；窗口显示时补发一次当前状态 |

### 2. 验证

- `cargo test -p pet-core`：**49 passed**（新增 `walk.rs` 2 项：走路挑哪边动画、方向按 `signum` 归一）；
- `cargo test -p gently`：**5 passed**（新增 `any_of_the_registered_areas_counts`：拖动条/精灵都算「里面」，空白处穿透）；
- `pnpm smoke`：**502**；`pnpm verify`：**8 道全绿**；
- **走动的实测证据（打包版日志 + 轮询窗口位置）**：
  `宠物出发去一个新的位置 target=709` → 窗口从 `1140,848` 一路走到 `709,848` → `宠物到地方了，歇一会儿 next_in_ticks=674`
  → 40 秒后 `宠物出发去一个新的位置 target=1310`、`走动方向变化 dir=1`；窗口位置随时间持续变化；
- **拖动的实测证据（部分）**：日志 `宠物可交互区域已更新 count=2`；光标放到**拖动条**上 `inside=true`（以前这里是 false → 永远收不到按下），窗口左下空白 `inside=false`；
- 打包版实图 `r102-pet-roam.png`：设置页宠物卡片新增「在屏幕上走动」开关与说明（`Gently 小助 v1.0.1`）；
- **没法自动验证的**：注入式鼠标事件（`mouse_event` / `SendInput`）驱动不了窗口拖动——连主窗口标题栏都拖不动（A/B 验过），所以「按住真的能把窗口拖走」只能人工确认。

### 3. 未做 / 下一步

- 走动只在 Windows 上（和 look/自动穿透同一条轮询）；其它平台宠物待着不动；
- 走动不避让窗口/任务栏（只在主屏底部那条线上挪，y 不变）；
- 拖动的人工验证还没做（见上），若你试了还有问题，告诉我具体现象（比如「按下去窗口不动」/「拖了但松手又弹回」）；
- 安卓仍按用户决定延后。

## 第一百零一轮

> 起点：R99/R100 把「看鼠标」和「自动穿透」做完了，功能面其实已经齐了——但版本号还是 0.x，
> 设置页还写着「实验（预开发）」，也没有给用户看的说明。
> 目标：**把宠物收成 Beta 1.0.0**：版本对齐、入口升格、交互补齐（喂食）、文档与证据齐全。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| 版本 | `pet-core` 从 workspace 的 0.1.0 改成**自己的 1.0.0**（独立 crate 该有自己的版本）；内置宠物包 `pet.json` → 1.0.0（渲染器检测到版本变了会自动重装，实测库里已升到 `v1.0.0`）；渲染器 `version` → 1.0.0 |
| 入口 | 设置页卡片标题「实验（预开发）」→ **「宠物（Beta）」**，行内加 `Beta 1.0` 标记；提示文案重写（独立窗口 / 看鼠标 / 穿透 / 左键摸 / 右键喂食 / 默认关）；删掉不再使用的 `page.setting.experimental` 键 |
| 交互 | **右键宠物 = 喂食**（不用开设置页）：冷却中核心回错，界面用 2.5s 临时气泡如实说明「还不饿呢」，成功显示「好吃！」；核心驱动的气泡优先，到达时收掉临时气泡 |
| 文档 | 新增 [`docs/pet.md`](pet.md)（用户指南：开关 / 能做什么 / 窗口与穿透 / 导入社区包 / 数据位置 / **已知边界**）；README 加「宠物（Beta 1.0）」特性与文档行，命令表补 `check:pet` 与八道关卡；契约与 ADR 0010 补 M7（1.0 边界表） |

### 2. 验证

- `cargo test -p pet-core`：**47 passed**；`cargo test -p gently`：**4 passed**；`pnpm smoke`：**502**；
- `pnpm verify`：**8 道全绿**；
- 打包版实图：
  | 文件 | 内容 |
  |---|---|
  | `r101-pet-beta.png` | 设置页「宠物（Beta）」卡片：`宠物 Beta 1.0` + 启用、点击穿透开关、`Gently 小助 v1.0.0 出战 好感 24 拘谨` + 缩略图、喂食/换成这只/移除、导入入口 |
  | `r101-pet-feed-crop.png` | **右键喂食**生效：宠物头顶冒出「好吃！」气泡（宠物同时做出反应姿态） |
- **版本升级链路实测**：库里原先是 v0.5.0，启动后渲染器发现内置包版本变 1.0.0 → 自动重装，界面上显示 `v1.0.0`（不是手工改库）；
- 交付物重新生成：`release/gently-0.1.0-windows-x64.zip`（129.6 MB exe，SHA256 `d1e27b94…08d509d1`）。

### 3. 未做 / 下一步（都属于 1.x / 2.x，不再是 1.0 的缺口）

- 移动端渲染器（M4）、宠物在屏幕上走动、逐像素 alpha 命中、v2 素材的画面级验证、多宠物 UI、宠物包自定义文案词表；
- 非 Windows 平台没有全局光标：look 与自动穿透都不生效（只能手动锁定）——已在用户指南里写明；
- 安卓仍按用户决定延后。

## 最近三轮

| 轮次 | 主题 | 结论 | 详情 |
|---|---|---|---|
| R112 | P2-1 前台服务（保活 + 通知） | Kotlin `PlaybackService` + `PlaybackPlugin` 经 Tauri 移动插件桥由宿主命令 `playback_banner` 驱动；前端只在「在播/停/换歌」推一次。真机：`isForeground=true foregroundId=1001`，**熄屏 4 分钟 5→258/271（+253 秒）**，HOME 后台 1 分钟 4→68，放完自动退出；smoke 529 | [本轮](#本轮目标第一百一十二轮) |
| R111 | P2 入口条件实测 + 中断恢复 | 真机测出**熄屏后三种形态**（音频停住 → 位置僵死 → 页面被重载），进程全程没死 → **P2 定为「WebView 播放 + 前台服务 + MediaSession」**；前端修对中断恢复：`play()` 带 3 秒上限、`isStalled()` 治「以为在播却不动」、`markInterrupted()` 如实停表并给「点播放继续」；smoke 528 | [下方](#本轮目标第一百一十一轮) |
| R110 | 安卓播放链路定案 | 「播不出声」不是解码问题：上游用 **HTTP 200 + HTML 错误页**冒充媒体；核心改为**按字节嗅探** `Content-Type`（含 `Range: bytes=0-` 路径）、插件 `mimeType` 不再丢、代理放宽 CORS、响应日志写清「回了什么」+ 非音频 WARN。真机用本地文件验证播放链路（206 + `aria-valuenow` 5→13/271）。新增真机 CDP 工具 `scripts/android-cdp.mjs`；核心单测 84 | [下方](#本轮目标第一百一十轮) |

## 历史轮次

- R01–R83：[`archive/rounds/R01-R83.md`](archive/rounds/R01-R83.md)
- R84–R88：[`archive/rounds/R84-R88.md`](archive/rounds/R84-R88.md)
- R89–R100：[`archive/rounds/R89-R100.md`](archive/rounds/R89-R100.md)（宠物从 M0 到 1.0 的全过程；R99/R100 为摘要）

默认不需要读；查「当时为什么这么做 / 试过什么 / 证据文件叫什么」时再打开。


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

## 下一步（按评估结论排序）

1. **宠物 M4（可以暂缓）**：移动端渲染器 + 独立化落地。核心层已经独立（ADR 0010「独立化评估」），
   要做只是把「宿主入口 / 渲染器 / 文案」搬一遍；触发条件是安卓决定重启。
2. **宠物玩法打磨（小步、随时可做）**：`minPetCoreVersion` 真版本比较、atlas 瘦身（1.5 MB）、
   走路时避让窗口/任务栏、多宠物 UI（存储与 API 已预留）、宠物包自定义文案词表、逐像素 alpha 命中。
3. **安卓（P1 已完成，下一步 P2）**：用户 2026-11-01 决定重启，形态定为**同一仓库 `src-tauri/gen/android`**、
   验收用**真机 USB**（`CDY_AN00` · API 29 · arm64）。**P0 当天已跑通**：NDK r28c + 4 个 target +
   `gen/android` + arm64 debug APK 装机启动，真机日志 8 条迁移 / `数据库就绪 version=8` / `宠物核心就绪`。
   拦路虎 `rquickjs-sys` 缺 android 绑定已用 **vendored patch** 解决（GOTCHAS §48）；
   新踩的坑见 §50–§56（多窗口→白屏、dev 包不含资源、取证与数据目录、手机列表、`backdrop-filter` 抢包含块、
   button 遮罩不涂色、HTTP 200 + HTML 错误页冒充媒体）。计划与执行记录在 [`ANDROID-PLAN.md`](ANDROID-PLAN.md)，
   自检 `pwsh -File scripts/android-env.ps1`。
   **P1 六片全绿**（R108 外壳 P1-1/2/3 + R109 触摸语义 / 手机列 / 窗口能力 P1-4/5/6）：
   手机外壳 = 左侧抽屉（8 项）+ 搜索作 home + 常驻播放条（**不做推荐/排行榜**），列表两行式、行操作进 ⋯ 底部面板；
   证据 `r108-android-*.png` / `r109-android-*.png`。**R110 把「播不出声」定案**：真机播放链路是通的
   （本地文件 206 + `aria-valuenow` 5→13/271），故障来自上游拿错误页冒充音频；
   真相见 `媒体响应` 日志与 GOTCHAS §56。
   **下一个入口条件是 P2**：先实测「锁屏 5 分钟后 WebView `<audio>` 还活着吗」——那一步决定
   「WebView 播放 + 保活」还是「原生 Media3 播放器」。**R110 之后可做的小任务**：
   把「上游返回的不是音频」变成用户能看懂的文案（在 `playback.resolve` 里先探一次并自动换候选，
   或加一条契约事件）。
4. **工程债**：`GOTCHAS.md` 56 条按域拆分；截图证据改成「seeded 数据 + 可深链 + 固定浅/深基线」，
   不再靠手算坐标（真机这半已由 `scripts/android-cdp.mjs` 解决：按文本点、整屏截图、读 DOM 断言）；
   拖动/悬停这类**注入式输入验证不了**的交互，补一份人工验收清单。
5. 背景 P2（带 JS / 多文件网页壁纸）与迷你歌词视觉细调仍挂着，未排期。












