---
status: active
last_verified: 2026-11-02
owner: gently
scope: 当前迭代状态与下一步
token_budget: 250
tldr: 当前 R119（P3 余项）：导入是「拷一份」，而原来的「移除」只移出曲库、文件留在磁盘——私有目录只涨不清。新宿主命令 `imported_dir`（Kotlin 回 `<filesDir>/music`，前端不猜）→ `importedMusicDir()` 缓存 → 纯函数 `importedTracksOf` 按**路径前缀**挑副本（拿不到目录就一条不删）→ `purgeImported()` 连文件一起删（正在播的先停）→ `ScanPanel` 手机形态给「清理副本」+ 危险确认。真机：曲库 3 首 → 清掉 2 个副本（`files/music` 变空、`probe` 留下、正在播的已停）。归档：R115 迁进 `archive/rounds/R101-R115.md`。smoke **552**。
---

# STATE

## 本轮目标（第一百一十九轮）

> 起点：R114/R118 的导入是**拷一份**（原文件删掉不影响曲库），反面是占双份空间。
> 而当时「移除」只移出曲库、**文件留在磁盘**——应用私有目录只涨不清，用户没有任何入口腾空间。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| 宿主（`importer.rs` / `lib.rs` / Kotlin `ImportPlugin`） | 新宿主命令 `imported_dir`：Kotlin 回 `<filesDir>/music`（前端不该猜这个绝对路径）。桌面端回空串 |
| 服务（`import.service.ts`） | `importedMusicDir()`：问一次就缓存（同一个安装内不变）；读不到返回 `null`，**不缓存失败** |
| 纯函数（`utils/importNote.ts`） | `importedTracksOf(tracks, dir)`：按**路径前缀**挑出导入副本；`dir` 为空时返回空数组——拿不到目录就一条都不删 |
| store（`library.slice.ts`） | `purgeImported()`：挑出副本 → 若正在播的是其中一首先 `stop()`（文件删了还显示「在播」就是骗人）→ 逐条 `library.local.remove{deleteFile:true}` → 从列表摘掉；返回清理条数 |
| 界面（`ScanPanel` 手机形态） | 有副本时多一行「应用内已导入 N 首（副本）」+ `清理副本`；走 `useConfirm()` 的危险确认，清完提示「已清理 N 首（连同应用内的副本文件）」 |

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**552**（549 → +3：只挑导入目录里的（同前缀的兄弟目录不算）/ 没目录时一条不挑 / 无宿主时清理是空操作）；
- **真机（`CDY-AN00`）**（清理前曲库 3 首，磁盘 2 个副本文件）：

  | 步骤 | 结果 |
  |---|---|
  | 本地音乐 → 展开扫描面板 | 出现「应用内已导入 2 首（副本）」+「清理副本」——`probe` 的文件不在导入目录里，所以不计入（`r119-android-clean-entry.png`） |
  | 点「清理副本」 | 危险确认：「将从曲库移除并从磁盘删除应用内的 2 个导入副本。你自己扫描进来的音乐不受影响（原文件也不受影响）」（`r119-android-confirm.png`） |
  | 确定 | 「已清理 2 首（连同应用内的副本文件）」；曲库 3 → **1 首**（`probe` 留下）；`run-as … ls files/music` → **空**；正在播的 `zhi-ni` 已停播、播放条回到「还没有播放歌曲」（`r119-android-cleaned.png`） |

### 3. 未做 / 值得你知道的

- 只按**路径前缀**认副本，所以「用户在别处自己扫描进来的音乐」永远不在清理范围内——刻意的最小权限；
- 清理逐条串行调用（几十首会有点慢），没有进度条；导入进度条与音乐目录导出仍挂着（P3 余项）；
- 归档：本轮把 R115 迁进 `archive/rounds/R101-R115.md`（原 `R101-R114.md` 改名，frontmatter 与引用一并更新）；
- P2-2 余项（`ACTION_SEEK_TO` + `onSeekTo`、`POST_NOTIFICATIONS`）与 R110 的「上游不是音频」进 UI 文案仍挂着。

## 本轮目标（第一百一十八轮）

> 起点：R114 的导入只能选「系统认得的音频」。真机一验：把同一个文件改名成 `.mp3` 就能选，
> `.m4s` 是**灰的**——而 `.m4s` 正是 B 站下载下来的音频，用户库里很常见。等于「导入」对这类文件完全无效。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| Kotlin（`ImportPlugin.kt`） | 选择器不再只过滤「音频类型」：`type="*/*"` + `EXTRA_MIME_TYPES=["audio/*","application/octet-stream"]`（未知封装落在 octet-stream 里，因此可选），选完由 `isAudioName()` 按扩展名筛；名单与核心 `AUDIO_EXTENSIONS` **一一对应**（12 个），跳过数如实回报 `skipped` |
| 宿主（`importer.rs`） | `ImportOutcome` 加 `skipped`（`#[serde(default)]`，老前端不会炸） |
| 前端（`services/import.service.ts`） | 结果类型与空结果都带 `skipped` |
| 文案（`utils/importNote.ts` 新，纯函数） | 五种结局各说一句话：打不开选择器 / 取消（不说话）/ 选中的都不是音频（说清跳过了几个）/ 没读到音频 / 部分成功（成功 + 跳过一起说）。原来这段判断散在 `ScanPanel` 里，测不到 |
| 文案（zh+en） | 新增 `importSkipped`、`importSkippedOnly`；`scanHint` 的扩展名列表补全成 12 个（原来少了 `m4b`/`m4r`/`oga`） |

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**549**（545 → +4：无宿主时 `skipped` 也是 0 + 导入文案四种结局）；
- **真机（`CDY-AN00`）**：

  | 步骤 | 结果 |
  |---|---|
  | 修复前（`audio/*`） | `/sdcard/Download/zhi-ni.m4s` 在选择器里**灰掉**（同一个文件的 `.mp3` 副本可选）——`r118-picker-audio.png` |
  | 修复后 | 同一个 `.m4s` 变成可选（`r118-picker-open.png` / `r118-picker-scrolled.png`） |
  | 选它 → 导入 | 「已导入 1 首」；磁盘多出 `zhi-ni.m4s 4388383`；扫描「新增 1」；列表出现 `zhi-ni`（`r118-android-import-m4s.png`） |
  | 播放导入的 `.m4s` | `aria-valuenow=8 / aria-valuemax=271`，进度在走——**不只是拷进来，真能放** |
  | 选非音频（`not-audio.bin`，octet-stream 所以可选） | 「选中的 1 个文件都不是音频」；磁盘**没有**多文件（`r118-android-import-skipped.png`） |

### 3. 未做 / 值得你知道的

- 系统 MIME 库不认的封装现在也能导入了，但**名单要对齐两处**：`core/src/local_library.rs::AUDIO_EXTENSIONS`
  与 Kotlin 的 `AUDIO_EXTENSIONS`——加一种就得同时改，否则「选得了却拷不进来」；
- 多个大文件仍然没有进度条（P3 余项），也没有「清理已导入」（拷一份会占双份空间）；
- 一句编译坑：Kotlin 块注释里写 `audio/*` 会**当场闭合注释**，报 `Expecting an element`（GOTCHAS §63）；
- 归档规则照旧：本轮把 R114 迁进归档（原 `R101-R113.md` 改名成 `R101-R114.md`）。

## 本轮目标（第一百一十七轮）

> 起点：R116 之后通知栏会显示「正在唱的那一句」，但 `PlaybackState` 仍然是
> `position=-1`（当时刻意的取舍：位置不进原生）。代价是锁屏 / 车机 / 蓝牙
> 拿不到「放到哪」，进度条一律不显示；通知小图标也还是系统自带的播放三角。

### 1. 本轮做了什么

| 层 | 改动 |
|---|---|
| store（`player.slice.ts` / `types.ts`） | `seekSeq`：位置**跳变**的计数（用户 seek、恢复时的跳位都算，正常 250ms 小步不算）。正常进度回写不碰它，所以订阅方不必订阅 `elapsed`（那会让整棵外壳每秒重渲染） |
| 前端（`playbackBanner.service.ts` / `useAudioEngine.ts`） | `syncPlaybackBanner` 多两个参数 `positionMs` / `durationMs`（毫秒整数，Kotlin 不做浮点换算），去重键带上它们——拖了进度一定推得出去。effect 依赖加 `seekSeq` 与 `duration`（**时长是异步到手的**，见坑 1），位置在 effect 里按需 `store.getState()` 读准确值 |
| 宿主（`playback.rs` / `lib.rs`） | `playback_banner` 与 `playback::update` 多两个 `i64`（毫秒）；注释写明这是**显示值**，原生不据此计时 |
| Kotlin（`PlaybackService.kt`） | `PlaybackState.setState(state, position, speed)`：播放中速度 1f **由系统自己推算**，暂停时必须 0f；`MediaMetadata` 写 `METADATA_KEY_DURATION`；时长未知时位置给 `PLAYBACK_POSITION_UNKNOWN`。**不声明 `ACTION_SEEK_TO`**（锁屏拖动还没接，声明了就是假的） |
| 通知图标 | 新的 `res/drawable/ic_gently_notification.xml`（24dp 音符剪影，纯白——系统只取 alpha 着白色），替掉 `android.R.drawable.ic_media_play` |
| 取证工具 | `scripts/probes/playbar-state.js` / `playbar-toggle.js` / `playbar-geometry.js`：读播放条状态、点播放暂停并捕获异常、读按钮几何（点上没有反应的排查顺序） |

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**545**（541 → +4：`seekSeq` 在 seek 后 +1、正常回写不变、
  媒体元素大跨度跳变也算跳变、位置/时长进键后拖进度一定换键）；
- **真机（`CDY-AN00`）**：本地曲目 `import-test`（271 s），全程读 `dumpsys media_session`：

  | 操作 | 结果 |
  |---|---|
  | 冷启动（恢复成暂停态，`elapsed=231`）→ 点播放 | `state=3, position=231200, speed=1.0`（本轮之前这里恒为 `-1`） |
  | 点进度条中点（≈50%） | 页面 `135` → `position=135465`，说明**拖进度会重推** |
  | 媒体键暂停（`input keyevent 127`） | `state=2, position=240154, speed=0.0`（暂停时速度归零，系统不会再往前推） |
  | 再点播放 | `position=240343`（回到暂停时的位置重新对齐） |
  | 元数据 | `metadata: size=4`（多出 `METADATA_KEY_DURATION`） |
  | 通知栏 / 锁屏 / 控制中心 | 小图标变成自己的 ♪（`r117-android-notification.png`、`r117-android-lockscreen.png`）；**三处都不画进度条**——本机 ROM 的取舍，数据在会话里，可见面等 Android 11+ 或车机 |

### 3. 未做 / 值得你知道的

- **坑 1（第一版就是不生效）**：`duration` 是媒体元素加载完才回写的，没进 effect 依赖 →
  原生一直「时长未知」，`metadata: size=3` + `position=-1`，看着像没跑；
- **坑 2**：恢复曲目时元素先报 `0` 再跳到续播点，于是原生停在 0——所以 `setProgress` 里
  把「大跨度跳变」也算成跳变（GOTCHAS §62）；
- `ACTION_SEEK_TO` / `onSeekTo`（锁屏拖进度）刻意没接：需要一条「原生 → 页面」的 seek 通道，
  而且本机 ROM 不画进度条，接了也验不到——留着等有可见面再做；
- `POST_NOTIFICATIONS` 运行时授权入口仍未做（本机 API 29 用不到，API 33+ 才有意义）；
- P3 余项（导入进度、「清理已导入」、`.m4s` 的 MIME、音乐目录授权/导出）与 R110 的
  「上游不是音频」进 UI 文案仍挂着。

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

## 最近三轮

| 轮次 | 主题 | 结论 | 详情 |
|---|---|---|---|
| R119 | P3 余项：清理导入副本 | 新宿主命令 `imported_dir`（前端不猜 `<filesDir>`）+ `importedMusicDir()` 缓存 + 纯函数 `importedTracksOf`（路径前缀，拿不到目录一条不删）+ `purgeImported()`（要删的正在播就先停，逐条 `library.local.remove{deleteFile}`）；`ScanPanel` 手机形态给「清理副本」+ 危险确认。真机：3 首 → 清掉 2 个副本（磁盘 `files/music` 空、`probe` 留下、正在播的已停）；smoke 552 | [本轮](#本轮目标第一百一十九轮) |
| R118 | P3 余项：任意封装都能导入 | 真机证实系统 MIME 库不认 `.m4s`（同一个文件改 `.mp3` 就能选），于是选择器放开到「音频 + 未知类型」，选完按扩展名筛（名单与核心 `AUDIO_EXTENSIONS` 一一对应），跳过数如实回报；结果文案抽成纯函数 `importNoteText`。真机：`.m4s` 可选 → 已导入 1 首 → 能放（`8/271`）；选 `.bin` → 「都不是音频」且磁盘没多文件；smoke 549 | [下方](#本轮目标第一百一十八轮) |
| R117 | 通知/锁屏拿到真实位置与时长 + 自有通知图标 | `playback_banner` 多两个毫秒参数，`PlaybackState.setState(state, position, speed)` + `METADATA_KEY_DURATION`；`seekSeq` 记「位置跳变」所以不必订阅 `elapsed`；时长异步到手、元素跳位两个坑写进 GOTCHAS §62。真机：恢复 231 s → 播放 `position=231200`、拖到 50% `135465`、暂停 `speed=0.0`；小图标换成自己的 ♪ | [下方](#本轮目标第一百一十七轮) |

## 历史轮次

- R01–R83：[`archive/rounds/R01-R83.md`](archive/rounds/R01-R83.md)
- R84–R88：[`archive/rounds/R84-R88.md`](archive/rounds/R84-R88.md)
- R89–R100：[`archive/rounds/R89-R100.md`](archive/rounds/R89-R100.md)（宠物从 M0 到 1.0 的全过程；R99/R100 为摘要）
- R101–R115：[`archive/rounds/R101-R115.md`](archive/rounds/R101-R115.md)（桌面收尾 + 宠物 1.0 + 安卓 P0–P4 共 15 轮正文）

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

## 下一步（按评估结论继续）

1. **安卓收尾（都不挡路）**：`ACTION_SEEK_TO` + `onSeekTo` 回页面（锁屏/车机拖进度——先确认有可见面再声明）、
   `POST_NOTIFICATIONS` 运行时授权入口（API 33+ 才有意义）；P3 余项（导入进度条、「清理已导入」、音乐目录导出）。
   通知栏歌词（R116）、位置/时长 + 自有图标（R117）、任意封装导入（R118）已落地。
   进度与拆分表见 [`ANDROID-PLAN.md`](ANDROID-PLAN.md) §7；每步的验收口径在 §4。
2. **R110 留下的小任务**：把「上游返回的不是音频」变成用户能看懂的文案（`playback.resolve` 里先探一次并自动换候选，
   或加一条契约事件），别只留在日志里（GOTCHAS §56）。
3. **宠物 M4 / 玩法打磨（随时可做、可暂缓）**：移动端渲染器（核心层已独立，见 ADR 0010）；`minPetCoreVersion`
   真版本比较、atlas 瘦身（1.5 MB）、走路避让窗口/任务栏、多宠物 UI（存储与 API 已预留）、逐像素 alpha 命中。
   触发条件是安卓决定做宠物。
4. **工程债**：`GOTCHAS.md` 63 条按域拆分（现在是一份长表，查起来靠搜索）；截图证据改成「seeded 数据 + 可深链 +
   固定浅/深基线」，不再靠手算坐标（真机这半已由 `scripts/android-cdp.mjs` 解决）；拖动/悬停这类**注入式输入
   验证不了**的交互，补一份人工验收清单。
5. 背景 P2（带 JS / 多文件网页壁纸）与迷你歌词视觉细调仍挂着，未排期。
