---
status: active
last_verified: 2026-11-02
owner: gently
scope: 当前迭代状态与下一步
token_budget: 250
tldr: 当前 R114（P3 SAF 导入）：安卓上「粘贴目录再扫描」只对开发者成立（普通用户拿不到绝对路径），本轮补上真正的入口——Kotlin `ImportPlugin` 走 **SAF**（`ACTION_OPEN_DOCUMENT`，`audio/*`，可多选），在后台线程把选中的 URI 拷进 `<filesDir>/music`（同名不覆盖、**不需要任何存储权限**），经 `src-tauri/src/importer.rs` 的移动插件桥 + 宿主命令 `import_audio` 回到前端；`ScanPanel` 在手机形态多一行「从手机导入音频」，导入后拿返回的 `dir` 直接调核心 `library.local.scan` 入库。真机走了一遍「选择器 → 下载内容 → 选文件 → 已导入 1 首 → 列表出现 import-test、磁盘有文件、扫描新增 1」。smoke 534 → **535**。
---

# STATE

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
| R114 | P3 SAF 导入 | 手机上终于能自己把音乐弄进来：Kotlin `ImportPlugin`（`ACTION_OPEN_DOCUMENT` 多选 → 后台线程拷进 `<filesDir>/music`，**零存储权限**）→ 宿主命令 `import_audio` → `ScanPanel` 手机形态的「从手机导入音频」→ 拿目录调 `library.local.scan`。真机：选文件 → 已导入 1 首 → 列表出现、磁盘有文件、扫描新增 1；smoke 535 | [本轮](#本轮目标第一百一十四轮) |
| R113 | 页面重载后的续播（P2-3） | 「上次在放什么 / 放到哪」落进 localStorage（纯函数校验、10 秒节流、不存队列），启动恢复成**暂停态**并补候选；`toggle()` 对「没有地址的暂停」走 `recoverPlayback()`；`seek()` 不再在元素未建时放弃。真机 `150/271` → 冷启动 → 点播放 `156/271`；smoke 534 | [归档](archive/rounds/R101-R113.md#本轮目标第一百一十三轮) |
| R112 | P2-1 前台服务（保活 + 通知） | Kotlin `PlaybackService` + `PlaybackPlugin` 经移动插件桥由宿主命令 `playback_banner` 驱动；前端只在「在播/停/换歌」推一次。真机 `isForeground=true foregroundId=1001`，**熄屏 4 分钟 5→258/271（+253 秒）**，HOME 后台 1 分钟 4→68，放完自动退出；smoke 529 | [归档](archive/rounds/R101-R113.md#本轮目标第一百一十二轮) |

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

## 下一步（按评估结论排序）

1. **安卓 P2-2 / P4**：MediaSession + 通知栏传输控制（`PendingIntent` 回服务，**播放状态必须回 store**）、
   通知图标换成应用自己的、`POST_NOTIFICATIONS` 运行时授权入口；P4 的通知栏歌词复用同一套前台服务。
   进度与拆分表见 [`ANDROID-PLAN.md`](ANDROID-PLAN.md) §7；每步的验收口径在 §4。
2. **R110 留下的小任务**：把「上游返回的不是音频」变成用户能看懂的文案（`playback.resolve` 里先探一次并自动换候选，
   或加一条契约事件），别只留在日志里（GOTCHAS §56）。
3. **宠物 M4 / 玩法打磨（随时可做、可暂缓）**：移动端渲染器（核心层已独立，见 ADR 0010）；`minPetCoreVersion`
   真版本比较、atlas 瘦身（1.5 MB）、走路避让窗口/任务栏、多宠物 UI（存储与 API 已预留）、逐像素 alpha 命中。
   触发条件是安卓决定做宠物。
4. **工程债**：`GOTCHAS.md` 59 条按域拆分（现在是一份长表，查起来靠搜索）；截图证据改成「seeded 数据 + 可深链 +
   固定浅/深基线」，不再靠手算坐标（真机这半已由 `scripts/android-cdp.mjs` 解决）；拖动/悬停这类**注入式输入
   验证不了**的交互，补一份人工验收清单。
5. 背景 P2（带 JS / 多文件网页壁纸）与迷你歌词视觉细调仍挂着，未排期。
