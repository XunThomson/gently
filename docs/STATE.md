---
status: active
last_verified: 2026-11-02
owner: gently
scope: 当前迭代状态与下一步
token_budget: 250
tldr: 当前 R116（P4 通知栏歌词）：歌词**只在页面算**（`utils/lyrics.ts::currentLyricLine`），当前行作为 `playback_banner` 的 `line` 参数一路到 Kotlin，写成通知第二行（空串回落歌手）与 `MediaMetadata` 的 `DISPLAY_SUBTITLE`；去重键 `playbackBannerKey()` 带上 `line`，**换行才推一次**。真机同一张通知原地把「第一句」换成「第二句」，`metadata: size=3 state=3`。两个取证坑：`dumpsys media_session` 的 `description` 第三项是 **ALBUM**（恒 null，判断不了字幕），系统界面只能用 `adb exec-out screencap -p`（CDP `shot` 只有 WebView）。smoke **541**。
---

# STATE

## 本轮目标（第一百一十六轮）

> 起点：R115 之后通知栏能上一首/暂停/下一首了，但第二行永远是歌手。用户要的是**正在唱的那一句**。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| 前端（`utils/lyrics.ts`） | `currentLyricLine(lines, elapsed)`：没有命中行返回空串。歌词**只在页面算**，原生不碰时间轴 |
| 前端（`services/playbackBanner.service.ts`） | `syncPlaybackBanner(active, title, artist, playing, line = '')`；去重键 `playbackBannerKey()` 把 `line` 也算进去——**换行才推一次**，不逐帧打原生。`useAudioEngine` 用一个返回字符串的 selector 取当前行 |
| 宿主（`playback.rs` / `lib.rs`） | `update()` 与宿主命令 `playback_banner` 多第 5 个参数 `line` |
| Kotlin（`PlaybackService.kt` / `PlaybackPlugin.kt`） | `PlaybackBannerArgs.line` → `EXTRA_LINE`；`setContentText(if (line.isNotBlank()) line else artist)`，并写进 `MediaMetadata` 的 `METADATA_KEY_DISPLAY_SUBTITLE` |

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**541**（539 → +2：`currentLyricLine` 命中/未命中、`playbackBannerKey` 换行后必须变）；
- **真机（`CDY-AN00`）**：本地曲目播放中（前台服务在），用 CDP 直接走宿主命令，两次只换 `line`：

  | 项 | 结果 |
  |---|---|
  | 第一次 `line='第一句：夜色温柔'` | 通知第二行 = 第一句：夜色温柔（`r116-android-lyrics-notification-1.png`） |
  | 第二次 `line='第二句：灯火未眠'` | **同一张通知原地更新**，标题与按钮不变，第二行换成第二句（`r116-android-lyrics-notification-2.png`） |
  | `dumpsys media_session` | `metadata: size=3`、`state=3`（会话存活） |

### 3. 未做 / 值得你知道的

- 本地曲目没有歌词，所以真机走的是「直接调宿主命令」的确定性验证；在线曲目（有歌词）在本机放不出声（GOTCHAS §56），
  端到端「跟着歌换行」只能在桌面端看；
- 两个**看文档容易踩空**的地方：`dumpsys media_session` 里 `description` 的第三项是 **ALBUM**（恒为 null），
  不能用它判断字幕有没有写进去；系统界面（通知面板 / 锁屏）只能 `adb exec-out screencap -p` 截，
  `node scripts/android-cdp.mjs shot` 只有 WebView 画面（已修脚本里的说明文字）；
- 歌词同步有 1 个节流的余量：`line` 变了才推，但通知文字更新本身是同步 IPC，长歌词行不会造成压力；
- 仍挂着：锁屏进度条（`position=-1`）、通知小图标换应用自己的、`POST_NOTIFICATIONS` 授权入口、
  P3 余项、R110 的「上游不是音频」进 UI 文案。

## 本轮目标（第一百一十五轮）

> 起点：R112 的前台服务让「熄屏还在放」成立，但通知栏只有一个「点一下回到应用」——
> 锁屏、蓝牙、耳机键都控制不了播放。P2-2 就是补这一半。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| Kotlin（`PlaybackService.kt`） | 接上 **framework 的 `MediaSession`**（`android.media.session`，API 21+，不引 `androidx.media` 少一条 Gradle 坑）：`MediaMetadata`（标题/歌手）+ `PlaybackState`（PLAYING/PAUSED + `PLAY/PAUSE/PLAY_PAUSE/SKIP_NEXT/SKIP_PREV`）+ `Callback`（onPlay/onPause/onSkipToNext/onSkipToPrevious）；通知改用 `Notification.MediaStyle`（`setMediaSession` + 三个按钮：上一首 / 播放·暂停 / 下一首，图标随 `playing` 切换） |
| Kotlin（`MediaActionBridge.kt`，新） | 原生 → 页面的**单向下发**：`Plugin.load(webView)` 里留 WebView 引用，按钮动作 → `evaluateJavascript("window.__gentlyMediaAction('toggle')")`。原生**不拥有播放状态**，只转发 |
| 宿主（`playback.rs` / `lib.rs`） | `playback_banner` 多一个 `playing` 参数（决定按钮图标与 `PlaybackState`） |
| 前端（`services/playbackBanner.service.ts`） | `syncPlaybackBanner(active, title, artist, playing)`；新增 `installMediaActionHandler()`：装 `window.__gentlyMediaAction`，**只在有宿主时装**，返回卸载函数。`useAudioEngine` 把它翻成 store 的 `toggle/next/prev`（与界面按钮同一条路） |
| 修复（本轮真机发现） | `active` 必须表示「**有没有当前曲目**」，不能等于 `playing`——第一版用同一个值，暂停就把前台服务连同 MediaSession 一起关了，之后耳机键/锁屏全部失效（GOTCHAS §60） |

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**539**（535 → +4：宿主里装上回调 / 三动作到得了前端且未知动作被忽略 / 卸载后全局函数被移除 / 无宿主是空操作）；
- **真机（`CDY-AN00`）**：

  | 项 | 结果 |
  |---|---|
  | 会话注册 | `dumpsys media_session`：`Media button session is com.xun.gently/gently-playback`、`state=PlaybackState {state=3 … actions=566}`（566 = play+pause+play_pause+skip_next+skip_prev） |
  | 暂停（媒体键 127） | 进度冻在 `6`；会话仍在（`state=2` PAUSED）——**这是修好 active/playing 之后才成立的** |
  | 播放（126） | `6 → 10`，会话回到 `state=3` |
  | 下一首（87） | 换歌（进度归 0 后重新走），通知标题跟着变成新曲目 |
  | 通知栏 | 三个按钮（⏮ ⏸ ⏭）；截图 `r115-android-notification.png` |

### 3. 未做 / 值得你知道的

- 通知小图标仍是系统自带的 `ic_media_play`（改成应用自己的需要加 drawable 资源）；
- `POST_NOTIFICATIONS` 运行时授权入口没有（API 33+ 不授权时通知不可见，但保活/媒体键仍生效）；
- `PlaybackState` 不带播放位置（`position=-1`）：位置不进原生，避免两处真相；锁屏进度条因此不显示；
- P4 通知栏歌词（可复用这套会话）、P3 余项（导入进度、清理已导入、`.m4s` 的 MIME）、
  R110 的「上游不是音频」进 UI 文案仍挂着。

## 本轮目标（第一百一十四轮）

> 起点：P0/P1/P2 都过了，手机上仍然只有一条「把音乐弄进来」的路——adb push。
> 这不是普通用户能做的事，等于「本地音乐」在手机上不可用。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| Kotlin（`gen/android/.../ImportPlugin.kt`） | `@Command pickAudio` → `ACTION_OPEN_DOCUMENT`（`audio/*` + 多选）；`@ActivityCallback` 里在**后台线程**逐个拷贝（`contentResolver.openInputStream`），同名不覆盖（`a.mp3` → `a-1.mp3`），回 `{imported, failed, cancelled, dir}`。SAF 不需要任何存储权限 |
| Rust 宿主（`src-tauri/src/importer.rs`） | 插件 `gently-import` 注册 Kotlin `ImportPlugin`，用 `run_mobile_plugin_async("pickAudio")`（异步：用户挑文件可能几十秒）+ `ImportOutcome` 结构体；`lib.rs` 新增宿主命令 `import_audio`。非 Android 如实回错（桌面端用「填目录」） |
| 前端 | `services/import.service.ts`（无宿主返回「取消」的空结果，浏览器里静默）；`ScanPanel` 在**手机形态**多一行「从手机导入音频」+ 说明 + 结果提示（已导入 N 首 / 部分失败 / 没读到音频 / 打不开选择器），导入成功后用返回的 `dir` 调 `library.local.scan` |
| 文案 | `page.local.importFromDevice/importing/importHint/imported/importedPartial/importEmpty/importFailed`（zh+en）；顺手修掉 `scanHint` 里那句已过时的「原生文件选择器需要额外的桌面插件」 |

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**535**（534 → +1「导入服务在无宿主时是空操作」）；
- **真机（）完整走查**（测试文件 `adb push` 到 `/sdcard/Download/import-test.mp3`）：
  1. 本地音乐 → 展开扫描面板 → 点「从手机导入音频」→ 系统选择器打开（「打开文件」：最近 / 音频 / 下载内容）；
  2. 抽屉 → 下载内容 → 只有 `import-test.mp3` 可选（其它非音频文件是灰的）→ 点选；
  3. 回到应用：提示「已导入 1 首」、「共 2 首」、列表出现 `import-test`；
  4. 磁盘：`run-as com.xun.gently ls -l files/music` → `import-test.mp3 4388383`；
  5. 入库：扫描结果「上次扫描 1 个文件，新增 1」；截图 `r114-android-import.png`。

### 3. 未做 / 值得你知道的

- **导入是「拷一份」**：原文件删掉不影响曲库；反面是占双份空间（后续可加「清理已导入」入口）；
- 选择器只过滤 `audio/*`：`.m4s`、少见的无损封装可能不在系统 MIME 库里（桌面端不受影响）；
- 多个大文件逐个拷没有进度条（只在结束后报数量）；P3 的其余部分（音乐目录授权、导出）未做；
- P2-2（MediaSession + 通知栏传输控制 + 自定义通知图标 + `POST_NOTIFICATIONS` 授权入口）、P4 通知栏歌词、R110 的「上游不是音频」进 UI 文案仍挂着。

## 最近三轮

| 轮次 | 主题 | 结论 | 详情 |
|---|---|---|---|
| R116 | P4 通知栏歌词 | 歌词只在页面算（`currentLyricLine`），`line` 作为 `playback_banner` 的第 5 个参数传到 Kotlin，写成通知的 `setContentText`（空串回落歌手）+ `MediaMetadata` 的 `DISPLAY_SUBTITLE`；去重键带上 `line`，换行才推。真机同一张通知原地把第二行从「第一句」换成「第二句」；smoke 541 | [本轮](#本轮目标第一百一十六轮) |
| R115 | P2-2 MediaSession + 传输控制 | framework `MediaSession` + `MediaStyle` 三按钮；原生只把 `toggle/next/prev` 经 `evaluateJavascript` 送回页面（播放状态仍以 store 为权威）。真机：暂停冻在 6 → 播放 6→10 → 下一首换歌且通知标题跟着变；`actions=566`；smoke 539 | [下方](#本轮目标第一百一十五轮) |
| R114 | P3 SAF 导入 | 手机上终于能自己把音乐弄进来：Kotlin `ImportPlugin`（`ACTION_OPEN_DOCUMENT` 多选 → 后台线程拷进 `<filesDir>/music`，**零存储权限**）→ 宿主命令 `import_audio` → `ScanPanel` 手机形态的「从手机导入音频」→ 拿目录调 `library.local.scan`。真机：选文件 → 已导入 1 首 → 列表出现、磁盘有文件、扫描新增 1；smoke 535 | [下方](#本轮目标第一百一十四轮) |

## 历史轮次

- R01–R83：[`archive/rounds/R01-R83.md`](archive/rounds/R01-R83.md)
- R84–R88：[`archive/rounds/R84-R88.md`](archive/rounds/R84-R88.md)
- R89–R100：[`archive/rounds/R89-R100.md`](archive/rounds/R89-R100.md)（宠物从 M0 到 1.0 的全过程；R99/R100 为摘要）
- R101–R113：[`archive/rounds/R101-R113.md`](archive/rounds/R101-R113.md)（桌面收尾 + 宠物 1.0 + 安卓 P0–P3 共 13 轮正文）

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

## 下一步（按评估结论排序）

1. **安卓收尾（都不挡路）**：锁屏进度条（`PlaybackState` 现在 `position=-1`）、通知小图标换成应用自己的、
   `POST_NOTIFICATIONS` 运行时授权入口；P3 余项（导入进度、清理已导入、`.m4s` 的 MIME、音乐目录授权/导出）。
   P4 通知栏歌词已落地（R116）。进度与拆分表见 [`ANDROID-PLAN.md`](ANDROID-PLAN.md) §7；每步的验收口径在 §4。
2. **R110 留下的小任务**：把「上游返回的不是音频」变成用户能看懂的文案（`playback.resolve` 里先探一次并自动换候选，
   或加一条契约事件），别只留在日志里（GOTCHAS §56）。
3. **宠物 M4 / 玩法打磨（随时可做、可暂缓）**：移动端渲染器（核心层已独立，见 ADR 0010）；`minPetCoreVersion`
   真版本比较、atlas 瘦身（1.5 MB）、走路避让窗口/任务栏、多宠物 UI（存储与 API 已预留）、逐像素 alpha 命中。
   触发条件是安卓决定做宠物。
4. **工程债**：`GOTCHAS.md` 61 条按域拆分（现在是一份长表，查起来靠搜索）；截图证据改成「seeded 数据 + 可深链 +
   固定浅/深基线」，不再靠手算坐标（真机这半已由 `scripts/android-cdp.mjs` 解决）；拖动/悬停这类**注入式输入
   验证不了**的交互，补一份人工验收清单。
5. 背景 P2（带 JS / 多文件网页壁纸）与迷你歌词视觉细调仍挂着，未排期。
