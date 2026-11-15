---
status: active
last_verified: 2026-11-15
owner: gently
scope: 当前迭代状态与下一步
token_budget: 250
tldr: 当前 R145：发现页合并推荐，只保留 Three.js 黑胶 demo（低机位、当前曲目封面铺底、仅播放时旋转）；两端歌词页改半透明，用户自定义背景可透出；设置里的宠物只留启用开关，控制面板拆成独立 `pet-panel` 窗口；歌词自动搜索改为候选 id + 聚合搜索取第一份带词结果；标题栏与启动屏换用 `src-tauri/icons/icon.png`，内置背景换成提供的 wallpaper.mp4；桌面歌词返回/更多功能/宠物 HUD 点击穿透已修；移动底部面板支持内容区下拉。typecheck / smoke 623 / verify 通过；后台重载仍未定位（只降低可见影响）、小尺寸视觉只是补了封面底，尚未整体重做。
---

# STATE

## 本轮目标（第一百四十五轮）

> 用户 2026-11-15 补充：所有底部抽屉下滑关闭；歌词页上划打开抽屉、抽屉去关闭按钮；
> 歌词页底部优先收藏 / 播放模式 / 音质；两端歌词页功能去重、移除封面背景；
> 歌词自动搜索默认关闭、设置可启用、按 id 取置顶结果；发现页清空并做 Three.js 3D demo；
> 宠物启用后从窗口消失；后台回前台仍会重载/卡死。

### 1. 逐条处理

| 反馈 | 结论与改动 |
|---|---|
| **所有下方抽屉下滑关闭** | 新增 `useSwipeDownClose`，应用到歌词工具面板 / 定时关闭 / 设置单选面板 / 行操作面板（行操作原有）；关闭按钮从底部面板移除，改用下拉、遮罩、系统返回 |
| **歌词页上划打开抽屉** | 歌词页底部控制区上划（或顶栏上划）打开**左侧导航抽屉**；工具面板由「更多 / 音质」按钮打开，面板下拉关闭，不再放 ✕ |
| **歌词页底部优先常用项** | 手机底部只留 **收藏 / 播放顺序 / 音质 / 更多**；下载、队列、歌单、定时等收进底部工具面板；播放顺序按钮循环 顺序→列表→单曲→随机 |
| **两端功能重复** | 桌面功能栏收成 3 个：**歌词工具 / 更多功能 / 定时关闭**；「更多」面板放歌曲操作与队列，不丢功能也不挤一排。手机播放条只留上一首/播放/下一首，歌词页补常用项 |
| **R145 回归修复** | ① 热门推荐 / 发现 / 排行榜在手机上重定向回手机主页；② 歌词页返回在「无历史」时不再 `navigate('/')`（会被最近路由快照弹回歌词页），改为直接去手机主页 / 桌面排行榜；③ 宠物窗口显示时先整窗穿透，只在真实热区放开；`menu_open` 不再让整块 HUD 画布吃点击（这是歌词页/播放条点不动的真因）；④ 宠物 5s 可见性心跳 |
| **发现页合并推荐** | `/hot` 去掉「热门推荐 / 发现」双 tab，整页只保留发现 3D demo；侧栏入口文案改为「发现」；手机的 `/hot`、`/ranking` 仍重定向 |
| **歌词页背景通透** | 桌面/手机歌词页去掉不透明底色，改为半透明 `--bg-app` + 轻模糊，用户自定义视频/图片背景能透出来；桌面播放条/面板仍保持可读表面 |
| **宠物设置收敛** | 设置页宠物组只保留「启用」开关；锁定 / 大小 / 走动 / 安装包配置全部移到宠物控制面板（R145 已拆成独立 `pet-panel` Tauri 窗口） |
| **宠物独立面板** | 新增 `pet-panel` 窗口（340×430，卡片自己的表面）；右键卡片 →「控制面板」打开；含喂食/摸头、大小滑杆、游走开关、隐藏宠物，Esc/关闭按钮收起；设置页不再重复 |
| **歌词自动搜索聚合** | 开启开关后先按候选源 id 找词；仍没有时调用 `catalog.searchLyrics(标题 歌手)`，按核心返回顺序取第一份**真正带歌词**的结果；手动选词仍可覆盖 |
| **3D 背景/旋转** | demo 用当前曲目封面铺底（模糊压暗，`backgroundUrl` 为后续背景仓库预留）；唱片只在 `player.playing=true` 时旋转，暂停即停 |
| **品牌与背景** | 标题栏/启动屏 favicon 改为 `src-tauri/icons/icon.png`；内置背景视频换为 `D:\Xun\Videos\3375392695_extracted\wallpaper.mp4`（复制到 `src/assets/bgc.mp4`） |
| **移动抽屉手势** | `useSwipeDownClose` 增加原生 touch 监听：除抓手外，面板内容滚到顶部时也可下滑关闭；按钮/输入/滑杆不抢手势 |
| **小窗视觉** | 迷你播放器铺一层当前封面（模糊 + 主题 token 控制透明度/模糊），小窗不再只有纯色底；720/560 两档实图已检查，560 进入迷你播放器；空态补了显式「展开」按钮 |
| **唤醒重载定位** | 最小化/遮挡恢复均无法复现；确认属于 Chromium/WebView2 唤醒重载（Tauri #8304），目前靠 Web Lock + 路由/播放快照 + 隐藏启动屏降低影响，见 GOTCHAS §90 |
| **R146 桌面修复** | ① 桌面定时关闭改成歌词页右上方内联浮层（不再用底部 sheet），实机点 3 分钟生效；② 去掉「更多功能」里重复的播放队列；③ 歌词页彻底去掉独立底色，只做排版；④ 宠物控制面板保留独立窗口，点回主窗口任意位置/主窗口获焦时收起；⑤ 迷你阈值从 720 降到 480，560–720 仍走同一套紧凑外壳与同一套 `Lyrics`；⑥ 560 宽播放条把音源/音质收进更多面板，避免与传输控件重叠；⑦ demo 增加偏心贴纸、提高转速，自定义背景时隐藏不透明墙让全局 bgc 透出 |
| **气泡收口** | 气泡层向本体方向收 8px，尾巴不再悬空；独立面板窗口已把「面板/气泡抢位置」从结构上拆开 |
| **移除封面背景** | 桌面/手机歌词页删除模糊封面垫底与顶栏大封面，只保留主题色轻微渐变；桌面顶栏保留 44px 缩略图 |
| **歌词自动搜索** | 新增 `ui.lyricsAutoSearch`（默认 **false**）；设置新增「歌词」组（桌面/手机都可见）；开启后当前源无词时按候选源曲目 id 顺序取第一份可用歌词，全空显示「暂无歌词」；`ensureLyrics(true)` 让开关立即生效 |
| **发现页 3D demo** | 发现 tab 清空原书架内容，改为 Three.js 唱片/专辑场景（程序化封面纹理、黑胶、唱臂、暖光、拖拽环绕、自动旋转、reduced-motion 停止）；新增 `three` 依赖。**StrictMode/重挂时每次新建 canvas**，避免第一次 `forceContextLoss` 让第二次 WebGLRenderer 读到 null precision 而整块空白；相机改为低机位（`basePhi=1.48`、视线压到唱片上沿），贴近参考照片 |
| **宠物消失** | `showPetWindow` 检查窗口尺寸（可见但 200×160 / DPI 变化也会重设并重新摆位）、最小化恢复、置顶；宠物窗口加空窗看门狗（6 秒无渲染器只重载一次） |
| **后台重载/卡死** | 路由快照从 sessionStorage 扩到 localStorage（30 分钟内进程被杀也回原页）；每 20s 刷新快照，`pagehide`/隐藏时写播放进度；回前台主动 `show + setFocus` 唤醒主窗口；Web Locks/反节流参数/宠物锚点保留 |

### 2. 验证

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm smoke` | **623 项全过** |
| `pnpm verify` | **通过**（typecheck + smoke 623 + 契约 / 可达性 + cargo 两 core/宿主 + check:pet） |
| `pnpm build:android` | 通过：`release/gently-0.1.0-android-debug.apk` 156.7 MB，SHA256 `4f4e247fba8d3d56a68392e20fef93974167fd2df201f8e6fcc272fb6d2dcbd9`，已安装真机 |
| 实图 | `release/screenshots/r145-desktop-lyrics.png`、`r145-desktop-demo-low.png`、`r145-mobile-lyrics.png`、`r145-mobile-quality.png`、`r145-mobile-drawer.png`、`r145-discover-demo.png`、`r145-discover-demo-mobile.png`、`r145-android-demo.png`、`r145-android-drawer.png`、`r145-android-setting.png`、`r145-android-lyrics.png`、`r145-pet.png`、`r145-pet-panel-window.png`、`r146-timer-popover.png`、`r146-small-560-final.png`、`r146-small-more-final.png`、`r146-mini-shared-lyrics.png`、`r146-demo.png` |
| 手势 | 浏览器 CDP 拖动：歌词工具/音质面板下拉后 `dialogs=0`；底部控制区上划后左侧抽屉打开（`x=0`），系统返回关闭；真机同样 |
| 真机 | R145 APK 安装：路由恢复 `/hot?tab=discover`、Three.js demo 正常渲染；底部只 4 个动作图标；设置「歌词」组与自动搜索开关可见；底部上划打开左侧抽屉、面板下拉关；暂停后按 Home 15 分钟回来 `window.__r145long` 仍在、点收起立即回 `/search`（页面未重载且可交互） |
| 回归修复验证 | 直接打开歌词页点收起 → `/search`（手机）/ `/ranking`（桌面）；手机打开 `/hot` 被重定向 `/search`；桌面「更多功能」面板含收藏/下载/加入歌单/队列；宠物卡片打开时点主窗口主题按钮仍生效（宠物 HUD 透明区不再吃点击）；Tauri dev 实图 3D demo 显示黑胶/封套 |
| 发现页合并 | `?tab=discover` 不再存在双 tab；桌面 `/hot` 标题「发现」，只有 3D demo；侧栏入口「发现」 |
| 启动屏 | 同一会话 reload 时 `html.is-resuming` 直接隐藏 `#boot-splash`，至少不再闪启动页；`wakeMainWindow` 改为 `unminimize + setFocus`，不再在任务栏恢复时 `show()`（底层重载仍待复现收口） |
| 3D 低机位 | `data-webgl='ready'`；实图 `r145-desktop-demo-low.png` 为唱片前景/封套直立的低机位视角 |
| 移动面板 | 真机从音质面板**内容区**（不是抓手）下滑，`dialogs` 从 1 → 0，关闭生效 |
| 宠物 | WebView2 实跑：窗口从 200×160 被主窗口 reload 自动校回 920×937；宠物可见、位置不因 reload 重摆；独立控制面板窗口 `pet-panel` 可打开（340×430） |
| 路由恢复 | 从 `/setting` 直接导航到 `/`（冷启动路径），30 分钟内快照生效回到 `/setting` |
| 未做 | 30 分钟以上后台长测；**任务栏恢复仍会重载**（本轮只隐藏了 reload 启动屏，底层未根治）；气泡与本体尾部的精细对齐仍待按 vpet 调；小尺寸窗口 UI 未系统重做 |

## 本轮目标（第一百四十四轮）

> 用户 2026-11-15 清单：移动/桌面 UI 隔离；长时间后台后整页重载、状态重置与卡死；
> 桌面歌词页功能收右上角竖排 icon、歌词居中；移动歌词页参考主流播放器；
> 宠物右键卡片 + 控制面板入口、尺寸只留滑杆；新增移动端一键构建脚本。

### 1. 逐条处理

| 反馈 | 结论与改动 |
|---|---|
| **移动/桌面 UI 没有隔离** | 歌词页拆成 `desktop.tsx` / `mobile.tsx` + 两份 CSS（`index.tsx` 只按 shell 分叉），共用 `NowPlayingLyrics` / 工具内容 / store；手机导航**统一在左侧抽屉**（8 项，不另加底部 tab）；主题页手机改 2 列紧凑卡，隐藏描述/作者/标签与「粘贴本机路径」导入；AGENTS #17 固化「两端分文件」 |
| **后台久了软件刷新/状态重置/卡死** | 根因是 Chromium/WebView2 隐藏约 5 分钟后 freeze/discard 页面。四层：① `utils/backgroundKeepAlive.ts` 持有一个永不完成的 Web Lock；② `tauri.conf.json` 三窗口统一反节流参数（`--disable-background-timer-throttling` / `-backgrounding-occluded-windows` / `-renderer-backgrounding`，并保留 wry 默认 features）；③ `sessionStorage` 记最后路由，同一会话再次加载时回原页（冷启动仍回首页）；④ 宠物窗口 `onMoved` 400ms 防抖落盘脚底锚点（走动也更新），`showPetWindow` 对已可见窗口不再重摆位 |
| **桌面歌词页功能收右上角 icon、歌词居中** | 桌面删除左封面栏，改为顶栏 44px 缩略图 + 居中歌词；右上角竖排 6 个纯图标（收藏/下载/歌单/播放设置/歌词工具/队列），点击在右侧展开面板，再点/Esc/点舞台/✕ 收起；`Lyrics` 新增 `centered`（`data-align='center'`），桌面歌词窗口仍左对齐 |
| **移动歌词页参考主流** | 全屏播放页：顶部「收起 + 标题/歌手」；居中歌词；底部 4 个 44px 操作图标（收藏/下载/队列/更多）→ 进度（时间 + SeekBar）→ 大号 上一首/播放/下一首；导航仍在左侧抽屉。队列/更多打开同一个底部工具面板（播放/歌词/队列三个 tab）。**顶栏向下拖可关闭**（固定 96px / 视口 18% 阈值，`utils/nowPlayingGesture.ts`） |
| **设置页移动适配** | 手机端每组一张卡、行 = 标签 + 当前值 + 箭头；单选改为底部选择面板（`ChoiceField`），布尔改为开关行（`ToggleField`，`role=switch`）；缓存上限 / 主页 / 音源 / 下载等长选项不再挤进行尾。桌面仍是行内单选 + 页内锚点导航 |
| **导航统一到侧边** | 试过底部 4 项后按用户要求撤回：手机主导航只保留左侧抽屉 8 项，底部只留常驻播放条；歌词页隐藏顶栏与播放条，但抽屉仍可横滑拉出 |
| **宠物右键卡片 + 控制面板** | 右键打开快捷卡片（名字/心情/等级 + 喂食/摸摸 + 「控制面板」入口），单值 `surface` 状态保证卡片与面板互斥；面板分「快捷/外观/行为」，**删除 small/medium/large 三个预设按钮**，尺寸只留滑杆 + 数字输入 + 当前 px；HUD 预留 260→340（面板不被窗口裁切），指针焦点不再留紫框 |
| **移动端一键构建** | 新增 `scripts/build-android.ps1` + `pnpm build:android`：默认 debug aarch64 APK → `release/` + SHA256；支持 `-Release` / `-SkipWeb` / `-Check` / `-Target`；缺 SDK/NDK/JDK/rust target 会给单条修复建议，release 无签名直接拦截 |

### 2. 验证

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm smoke` | **619 项全过**（新增重载路由、宠物卡片状态机、尺寸只有滑杆、平台布局、下滑关闭阈值断言） |
| `pnpm check:pet` | 通过 |
| `pnpm build` | 通过 |
| `pnpm verify` | **通过**（typecheck + smoke 619 + 契约 76/9 + 可达性 + cargo：gently-core 95 / pet-core 9+7+6+2+10+9+4+6 / 宿主 + check:pet） |
| `pnpm build:android` | **真实构建通过**：debug/aarch64 → `release/gently-0.1.0-android-debug.apk`（163.9 MB，universal flavor，SHA256 已写）；已 `adb install -r` 到真机（HUAWEI CDY-AN00 / Android 10） |
| 真 WebView2 手测（debug 宿主 + CDP） | `navigator.locks.query()` 能看到 `gently:background-keepalive`；宠物右键卡片/控制面板实图；`/setting` → 替换 URL 为 `/` 后 reload → 自动回到 `/setting` |
| 真机手测 | 抽屉 8 项、无底部 tab；设置页卡片行 + 开关/选择面板；歌词页居中、无底部 tab；**顶栏下滑关闭回 `/setting`**；暂停播放后按 Home、约 15 分钟回来 `window.__r144_paused` 仍是数字（页面未重载） |
| 实图 | `release/screenshots/r144-desktop-lyrics.png` / `-light.png`、`r144-desktop-panel.png`、`r144-mobile-lyrics.png`、`r144-mobile-sheet.png`、`r144-mobile-home.png`、`r144-mobile-setting.png` / `-background.png`、`r144-mobile-theme.png`、`r144-android-home-final.png`、`r144-android-drawer.png`、`r144-android-setting.png`、`r144-android-lyrics-final.png`、`r144-pet-card-page.png`、`r144-pet-panel-page.png` |
| 未做 | release APK 签名（脚本已拦截）；桌面「最小化 ≥10 分钟」长测；宠物浅色主题实图 |

### 3. 未做 / 下一步

- **真机复核已完成的部分**：抽屉 8 项、设置页卡片行、歌词页下滑关闭、暂停后后台约 15 分钟页面未重载（`window.__r144_paused` 仍在）。仍需补：① 播放中后台 30 分钟以上；② 浅色主题下宠物卡片/面板。
- **桌面长测**：最小化/锁屏 10 分钟以上，确认反节流参数 + WebLock 生效；若 WebView 仍被丢弃，再看 Windows 进程 EcoQoS（下一层：`SetProcessInformation` 关掉 power throttling）。
- **宠物**：卡片/面板真窗口（透明背景叠在桌面）观感已用 WebView2 页面截图确认；`PET_HUD_RESERVE=340` 让窗口画布更大，若觉得挡屏幕可再调。
- **主题页**：手机 2 列卡片已改；导入面板在手机隐藏「路径」来源，桌面保持不变。
- **构建**：`pnpm build:android` 已真跑并安装；release 包仍需签名配置（脚本会提前拦截，不会产不可安装的包）。

## 本轮目标（第一百四十三轮）

> 用户 2026-11-15 清单：移动端功能项从播放条迁到歌词页；设置页与歌词页重构；
> 移动端 bug（功能抽屉打不开、触摸蓝条）；宠物 bug（紫底、气泡高低、热区误判）；
> 移动端数据目录与「拷贝两份」的存储方案。

### 1. 逐条处理

| 反馈 | 结论与改动 |
|---|---|
| **功能项迁到歌词 view** | 新增 `NowPlayingTools`（播放 / 歌词 / 队列三格，惰性挂载，再点当前格可收起）；「播放」格组合 `PlaybackModes` + `ActionsPanel inline` + `PlaybackOptions`；「歌词」格把原 `LyricsToolsDrawer` 的三段竖排；「队列」格用 `QueuePanel inline`。删除 `MobilePlayerSheet` 与播放条上的「收藏 / 更多」位；手机播放条只剩 主体（点进歌词页）/ 上一首 / 播放暂停 / 下一首。AGENTS #9 重写 |
| **歌词页不符合审美** | 桌面：封面 ≤300px + 右栏歌词 + tabs 在歌词下方，封面只做模糊垫底；手机：隐藏外壳顶栏（`data-immersive`），封面只做整页模糊背景，歌词 17px 占主视觉。歌词不再套卡片（无底色 / 边框），只保留当前行加粗与上下渐隐。新增 `nowPlaying.*` token（`lyricsMaxWidth` / `backdrop*` / `toolTab*` / `mobileLyricsFontSize` / `lyricsInactiveOpacity`）；删除「封面已省略 / 作为背景」开关与 `utils/nowPlayingCover.ts` |
| **设置页混杂** | 8 个语义组（外观 / 播放与歌词 / 音源 / 下载 / 宠物 / 背景与主页 / 存储 / 关于），桌面左侧 sticky 锚点导航（IntersectionObserver 高亮），窄屏吸顶 chips；`Section` + `Field` 统一「组标题 + 一句话 + 行」，子卡拆成 h3 子块；缓存 / 歌词逻辑拆成 `CacheSettings` / `LyricsSettings`；手机去卡片、用分隔线 |
| **移动端功能抽屉打不开** | 该抽屉不再存在（功能进 tabs）。同批修掉真实根因级问题：`QueuePanel` 的 `scrollIntoView` 会把 immersive 内容区一起滚走，导致打开队列后「收起 + 标题」消失 → 改成只滚自己的列表；`MobileShell` 在沉浸式下钳住 `scrollTop = 0` |
| **触摸出现纯蓝横条** | WebView 默认 `-webkit-tap-highlight-color` 铺在被点元素的 border-box 上；全局关掉，按压反馈统一走组件 `:active`；触屏上清掉 `:focus:not(:focus-visible)` 的描边 |
| **宠物紫色背景 / 白框** | `.body` 基础样式原来直接写 `--brand` 紫底，靠 `.body.sprite` 覆盖（同为 0,2,0，只靠源码顺序）；改为 `data-kind=pending|sprite|fallback`：只有 fallback 才画品牌圆，sprite 只有几何；根链 `html/body/#root/[data-pet-window]` 全透明；焦点框只在键盘模态出现 |
| **宠物气泡高低不稳** | 气泡原来在 HUD 列中间，状态卡 / 菜单显隐会把它推远；改为 HUD 内独立层（贴本体那条边）+ 指向本体的尾巴（`bubbleTailOffset`）+ 固定 `PET_HUD_GAP`；显隐优先级 菜单 > 气泡 > 状态卡；出现 / 消失用 opacity + 8px 上浮 |
| **没碰到宠物也能交互** | 原来上报整个图集格子（208 档 207×225）；改为解码时降采样 512 长边、逐帧扫 alpha 得到包围盒，命中只报当前动画 ∪ look 的包围盒（+4px padding）；隐藏 / 卸载 / 窗口消失一律发空列表并清宿主热区（Rust `clear_hitboxes`） |
| **移动端数据目录 / 两份资源** | 新增 `docs/ANDROID-STORAGE.md`：数据在 `/data/user/0/com.xun.gently`（不在 `Android/data`，非 root 不可见），导入副本另在 `<filesDir>/music`，当前无任何导出出口；「只引用」会在 scan / publish / 封面 / 删除四处断，推荐 C 混合（拷贝默认 + 引用可选）+ SQLite `imported_files` 登记表保护删除。**本轮只给方案，不含实现** |
| **（顺带）恢复的曲目没歌词** | 冷启动恢复只恢复曲目 / 进度，不恢复歌词（启动不该联网）；新增 `player.lyricsDeferred` + `ensureLyrics()`，歌词页第一次打开时补一次 |

### 2. 验证

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm smoke` | **610 项全过**（新增命中矩形 / 气泡尾巴 / 歌词挂起 / 队列滚动 / 沉浸式守卫） |
| `pnpm check:contract` | 通过（76 命令 / 9 事件 / 错误码一致） |
| `pnpm check:reachability` | 通过（230 服务节点 / 102 动作节点） |
| `pnpm check:pet` | 通过 |
| `cargo test -p gently pet_watch::tests` | **7/7 通过**（含空热区 = 穿透、隐藏窗口清热区） |
| `pnpm verify` | **全绿**（typecheck / smoke 610 / 契约 / 可达性 / gently-core 95+ / pet-core / 宿主 14，离线模式） |
| `pnpm build` | 通过（dist 566 KB / gzip 187 KB） |
| 实图 | `release/screenshots/r143-desktop-lyrics.png` / `-light.png`、`r143-mobile-lyrics.png`、`r143-mobile-lyrics-playback.png`、`r143-mobile-lyrics-queue.png`、`r143-mobile-lyrics-tools-light.png`、`r143-desktop-setting.png` / `-light.png`、`r143-mobile-setting.png`、`r143-desktop-queue.png`（浏览器预览，1280×820 / 390×844，浅色 + 深色） |
| 未做 | 真机（Android WebView 蓝条 / tabs 触摸 / 宠物窗口透明与气泡）与带图形会话的打包版截图；`pnpm ui:capture` 未跑 |

### 3. 未做 / 下一步

- **真机复核**：① 歌词页 tab 打开 / 收起、播放条三键；② 长按进度条不再出现蓝条；③ 宠物窗口紫底 / 白框消失、气泡贴本体、宠物外 30–50px 不再能点开菜单。
- **宠物命中精度**：现在是「包围盒级」；若仍嫌大，下一步可把 12×12 占用栅格合成多矩形。
- **存储方案**：先落 `imported_files` 登记表（P0），`content://` 引用要等真机验证 provider 的持久授权与可 seek 能力（`docs/ANDROID-STORAGE.md` §5）。
- **桌面歌词页对齐**：目前仍是左对齐（项目既有 Netodia 风格）；若要像参考图一样居中，需要同时改桌面歌词窗口（共用 `Lyrics`），留给用户决定。
- **恢复曲目的歌词**：现在只在打开歌词页时补；直接看播放条不受影响。

## 本轮目标（第一百四十二轮）

> 「主窗口 12 秒内仍不可见」的深入调查：不是 WebView2 Runtime 坏了，而是进程以 **Low 完整性级别**
> 运行；只修 esbuild 的教训没有覆盖到 `gently.exe` / `WebView2Loader.dll` / `release`。

### 1. 定位与改动

| 层 | 改动 |
|---|---|
| 现场证据 | 运行中的 `gently.exe` 令牌是 `S-1-16-4096`（Low）；工作区根 Low；`tasklist` 无 `msedgewebview2.exe`；`EBWebView` 停在 11-12；当天 `logs` 不存在、`gently.db` 时间未变。WebView2 Runtime `157.0.4341.46` 已安装，`msedge.exe` 正常——**不先重装 WebView2** |
| 根因 | 标准登录令牌带 `TOKEN_MANDATORY_POLICY_NEW_PROCESS_MIN`：子进程 IL = min(父进程 IL, exe 文件 IL)。Low 的 exe 即使从 Medium 终端启动仍是 Low；Low 进程不能写 Medium 的 `%LOCALAPPDATA%\...\EBWebView` 与 `%APPDATA%`，WebView2 浏览器进程根本不启动 |
| `src-tauri/src/integrity.rs` | 新增只读检测：`GetTokenInformation(TokenIntegrityLevel)` → Low/Medium/High/System/Unknown；含纯函数映射与 Windows FFI 单测 |
| `src-tauri/src/lib.rs` | setup 里记录「进程完整性级别」；Low 时写明确 error（并提示从普通终端启动 + 修复标签） |
| `src-tauri/src/startup_guard.rs` | Low：1 秒后弹**专门** MessageBox 并 `exit(1)`，不再留下隐藏进程；Medium 但 12 秒不可见：日志补 `visible` / `outer_size` / IL，保留通用 WebView2 提示 |
| `scripts/check-integrity.ps1` | 检查工作区根 / `target` / `debug\gently.exe` / `release` 与当前终端 IL；`-Fix` 在管理员终端递归设为 Medium 并复查 |
| 文档 | GOTCHAS §78（Low IL → WebView2/日志失败）、§75/§76 交叉引用；明确「只修 esbuild 不够」 |

### 2. 验证

| 项 | 结果 |
|---|---|
| `cargo check -p gently` | 通过 |
| `cargo test -p gently --lib` | **13/13 通过**（含 `integrity` 映射与真实令牌读取） |
| Low 令牌实测 | 把测试二进制设为 Low 后运行：`current integrity = Low`，读取成功——Low 分支不是猜的 |
| `scripts/check-integrity.ps1` | 可运行；修复前快照：工作区根 **Low**，`target` / `debug\gently.exe` / `release` **Medium** |
| 真实启动 | **成功**：`cargo build -p gently` 后以 Medium 进程启动，日志 `进程完整性级别 integrity="Medium" rid=Some(8192)`；出现 WebView2 子进程，`EBWebView` 时间更新，主窗口 1280×800 可见，当天日志已生成；截图 `release/screenshots/r142-desktop.png` |

### 3. 下一步（用户侧）

- 当前工作区**根目录仍是 Low**；`target` / `gently.exe` / `release` 已是 Medium，所以本次能从普通进程启动。
  若要 `cargo clean` 后重建、或继续用 DSH workspace-write 终端，建议先在**管理员** PowerShell 执行
  `pwsh -File scripts/check-integrity.ps1 -Fix`（完成编辑后再做，目录会变成 Medium）。
- 用**普通 PowerShell**启动 `pnpm tauri dev` 或直接双击 `release\...\gently.exe`；若再出现无窗口，
  先看日志里的「进程完整性级别」与 `scripts/check-integrity.ps1`，不要先重装 WebView2。
- 若 Medium + Medium 仍无窗口，再查 WebView2 Runtime / profile；目前证据不支持先走那一步。

## 本轮目标（第一百四十一轮）

> 用户 2026-11-14 清单：3 个 bug（手机返回栈 / 宠物首帧 / 长暂停恢复）、
> 9 条优化（移动端功能补齐与播放条收敛、歌词偏移、宠物尺寸、文档、下载同名、
> 扫描目录、浅色亮度、定时关闭可调）。

### 1. 逐条处理

| 反馈 | 结论与改动 |
|---|---|
| **手机：点 x 次 player，返回要 x 次** | 根因是 `MobilePlayerBar` 无条件 `navigate('/now-playing')`：播放条在歌词页也常驻，每点一次就多压一条同路径历史。改用桌面已有的 `shouldOpenNowPlaying(pathname)`，已在歌词页就不再 push（R141） |
| **宠物启动先渲染默认 pet** | 宠物窗口的状态与图集是异步读的，兜底圆形本体在数据回来前已经可见。改为 `body.visibility:hidden`，**第一帧真正画好图集（或确认无图集、退回程序化本体）后才显示**；宁可晚几十毫秒，也不闪默认形象 |
| **长暂停后当前歌无法恢复播放** | 真机现场是「暂停 UI 变播放 UI，进度不动」。两处修：① 列表点当前曲目不再直接 `patch({playing})`，统一走 `toggle()`；② `toggle()` 在**暂停 ≥30 秒 / 元素有 MediaError / 已僵死 / 无地址**时调 `recoverPlayback()`，让核心重新解析地址并保留进度。判定抽成纯函数 `utils/playbackResume.ts` |
| **移动端缺少随机播放等功能** | store 新增 `shuffle` + `setShuffle`；`next` 随机挑非当前曲目，`prev` 回到随机历史；桌面播放条加随机按钮。手机播放条只留 4 个功能位（收藏 / 播放暂停 / 下一首 / 更多），其余进「更多」底部抽屉：上一首、随机、循环、定时关闭、音源、音质、下载、歌单、队列 |
| **歌词偏移不够灵活** | 时间轴校正新增**滑杆 + 数字输入**（±30 秒、0.1 秒精度），极端偏移不用连点几十次；原 ±0.1 / ±0.5 与归零保留 |
| **宠物尺寸只允许三档** | `PetSize` 从联合类型改为数值（显示高度），范围 **64–480px**；菜单与设置页都有滑杆 + 数字输入，104/208/312 只作快捷档；旧存档 `small/medium/large` 仍能读 |
| **下载同名文件会覆盖** | 核心建任务时按「目录中不存在 + 未被其他任务占用」生成唯一落盘名（`标题.flac` → `标题 (2).flac`）；完成时修正扩展名也走同一套唯一化。界面显示仍是曲目原名（`track.title`） |
| **手机导入：目录应为主、单文件为辅** | 手机本地页主按钮改为「扫描目录导入」，旁边可选「包含子目录 / 仅当前目录」；「选取单文件」降为次按钮。Kotlin `pickDirectory` 接收 `recursive`，Rust/TS 全链路透传 |
| **浅色主题太亮** | 浅色 scheme 整体降亮（`--bg-app` / `--bg-surface` 不再纯白、文字与边框同步收敛）；另加**用户可调**的「夜间柔光」（0–30%，默认 8%，0 即关闭），覆盖层 `pointer-events:none`，不挡操作 |
| **定时关闭最小项太大** | 预设改为 3/5/10/15/30/45/60/90 分钟，并新增 **1–720 分钟自定义输入**；不再替用户决定「只能选这几档」 |
| **文档压缩 / 用词优化** | README 重写压缩（修掉坏表格与过期 smoke 数）；AGENTS #9/#14、ARCHITECTURE、ROADMAP、ADR、契约里的「不可信代码 / 不信任」改为**「按外部输入处理 / 权限边界」**，只描述边界，不评判作者 |
| **文档异常补充（两个教训）** | GOTCHAS 新增 §76（Windows 管理员也写不进去：先查 `icacls` 的 `Mandatory Label`，Low IL 修 `Medium`）与 §77（Tauri `setup` `os error 5`：WebView2 数据目录与降权冲突，按优先级给处理方向） |

### 2. 验证

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm smoke` | **597 项全过**（新增随机选曲 / 长暂停恢复判定 / 宠物连续尺寸 / 浅色不再纯白） |
| `cargo test -p gently-core --test download` | **7/7 通过**（新增「同名标题生成两个不同文件」） |
| `cargo check -p gently` | 通过（宿主命令签名与 importer 改动） |
| `:app:compileArmDebugKotlin` | **BUILD SUCCESSFUL**（Kotlin `pickDirectory` 的 `@InvokeArg` 参数编译通过） |
| 浏览器 / 真机 / 打包 | **本轮未做**：手机返回栈、宠物首帧、长暂停恢复都需要真机或打包版复核；bundled APK 未出 |

### 3. 未做 / 下一步

- **真机复核三项**：① 歌词页连点播放条 x 次后，系统返回一次即回原页；② 冷启动宠物窗口首帧不出现默认圆形；③ 暂停 ≥30 秒后点当前歌能恢复出声（以及点其他歌仍正常）。
- **移动构建**：`pnpm build`（android）与 bundled APK 本轮未出；Kotlin 已编译通过，仍需真机安装验证「目录 / 仅当前目录」两条路径。
- **随机播放**：目前是会话级、不做「随机权重 / 已播完一轮」；若用户需要可再加「仅随机未播」策略（保持可选，不做强制默认）。
- **夜间柔光**：默认 8% 是经验值，若用户觉得仍亮可自行调到 30%；后续可考虑按时间段自动调整（需用户显式开启）。
- **文档压缩**：GOTCHAS 因新增两个长条目反而变长；下一步按域拆分（窗口/移动/宠物/构建）并保留索引，不再继续堆单文件。

## 本轮目标（第一百四十轮）

> 用户对 R139 的 5 条反馈：`tauri dev` 日志初始化 panic / 背景自由构图只在「自由」模式下可编辑 /
> 手机拖动配置项会触发侧边栏 / 手机导入背景仍白屏 / 补一个恢复默认设置项。

### 1. 逐条处理

| 反馈 | 结论与改动 |
|---|---|
| **`tauri dev` 启动 panic** | 根因是 `tracing_appender::rolling::daily()` 在当天日志文件被旧进程占用时**直接 `expect` panic**（`failed to create log file: 拒绝访问`）。改为 `RollingFileAppender::builder().build()`：正常文件名失败 → `gently.fallback-<pid>` → 再失败只输出控制台；启动不再因日志失败退出。实测：用 `FileShare.None` 锁住当天日志后启动 `gently.exe`，进程保持运行，stderr 显示「日志文件不可用…仅输出到控制台」 |
| **背景自由构图** | `BackgroundFit` 增加 `free`；设置页「对齐方式」= 铺满裁切 / 完整显示 / 拉伸铺满 / 自由。**只有选「自由」才渲染**水平、垂直、缩放、翻转四个控件；其它对齐方式隐藏，避免选了铺满仍被旧坐标拉偏。`flip` 是新增持久化字段，媒体层用 `scaleX(-1)` 应用 |
| **手机拖配置项触发侧边栏** | `MobileShell` 的抽屉手势在 `pointerdown` 排除 `input / textarea / select / [contenteditable] / [role=slider] / [data-drawer-swipe=off]`；设置页的 range 滑杆再也不会被当成横滑开抽屉。滑杆自身 `touch-action: pan-y`（纵向让页面滚动，横向归滑杆） |
| **手机背景空壳/白屏** | 两处根因一起修：① 从桌面同步来的 `background.kind: 'web'` 在手机上会渲染一张白 iframe，且「导入」打开的是 HTML 选择器——`BackgroundCard` 在手机强制回 `video`，`BackgroundVideo` 在手机也忽略 web；② 手机内容表面被 0.92 不透明度下限盖成白板——**改为默认 0.35、上限 0.50**（用户可调），并**强制关闭内容/壁纸毛玻璃**；只对迷你播放器保留 0.92 的视觉中心保护。设置项改名为「内容不透明度」，越低越能看见背景 |
| **恢复默认设置** | 设置页底部新增「恢复默认」卡片：二次确认后清 `gently:ui` 与 `lang`，重载页面；**不删除**本地音乐、插件、下载文件、凭据。背景素材的 IndexedDB 孤儿记录暂不清理（不影响使用） |

### 2. 验证

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm smoke` | **589 项全过**（更新了「手势排除表单控件」断言） |
| `pnpm verify` | **全绿**（含 core/宿主/pet 单测） |
| 日志锁文件实测 | 锁住当天 `gently.log` 后启动 `gently.exe`：进程未退出，stderr 走「备用文件/仅控制台」分支 |
| 移动构建 | 本轮重新出 bundled APK（删除旧 APK 后重建，避免 Gradle 追加导致 ZIP 尾部冗余） |

### 3. 未做 / 下一步

- **桌面 `tauri dev` 无窗口（WebView2 环境）**：代码侧已确认 `setup` 完整走完、主窗口对象存在（`has_main=true`），但 OS 窗口从未创建（`visible=false`、`outer_size` 返回 `FailedToReceiveMessage`）。用 `WEBVIEW2_USER_DATA_FOLDER` 指向一份工作 profile 曾经成功创建三个窗口；之后同一会话里新 profile / 新路径都再次卡住。判断是 WebView2 运行时/会话状态（17:47 前后 Edge 更新）而不是应用逻辑。已把原 profile 备份为 `%LOCALAPPDATA%\com.xun.gently\EBWebView.corrupt-<时间>`，当前 `EBWebView` 是保留 Local Storage/IndexedDB 的修复副本。**需要重启 Windows 会话（或修复 WebView2 Runtime）后再启动**；重启后若仍无窗口，再删 `EBWebView` 让 WebView2 重建（会丢界面设置/背景素材，曲库在 `%APPDATA%\com.xun.gently` 不受影响）。
- `gently.fallback-<pid>` 备用日志也不会被 `prune_old_logs` 清理（只在极端锁文件场景出现，量很小；下次可纳入 7 天清理）。
- 手机背景仍只支持视频/图片，网页壁纸继续只在桌面端。
- 恢复默认不清 IndexedDB 里的背景素材与皮肤素材（只清元数据），孤儿数据可在「清缓存」里统一处理。

## 本轮目标（第一百三十九轮）

> 用户 2026-11-08 清单：移动端适配（移除首页模块 / 新机型差异 / 按钮渲染错乱 / 退后台重载）、
> 启动提速与品牌启动屏、目录扫描导入、背景坐标自由调整、宠物行为=动画、概率性点击无响应、
> 封面背景占比、歌词页音频律动、MusicFree 插件适配、完善宠物养成。
> 本轮把「明确是 bug 的」先收口，扩展项按「契约不变、可回滚」的方式落地。

### 1. 逐条处理

| 用户问题 | 结论与改动 |
|---|---|
| **移动端首页模块（概念混淆）** | 删除 `src/components/mobile-home/**` 与 `views/setting/components/home-modules-card.tsx`，store 里 `homeModules` 全链路移除；改为设置页「主页」选择（`ui.homePath`，`config/mobileNav.ts` 是路径/文案唯一来源），根路由 `/` 按它重定向。搜索页空闲态恢复为普通 `EmptyState` |
| **新机型 UI 差异** | `MobileShell` 顶部改成 `max(env(safe-area-inset-top), 30px)`（旧机兜底仍来自 `app.config`），抽屉同步；播放条 `height:auto` + `min-height` + 底部 `env(safe-area-inset-bottom)`，标题/歌手 `line-height: tight`（font_scale 1.17 不再把第二行裁掉）；`.seek` 成为定位包含块，进度条不再铺到屏幕边缘；无曲目时不画焦点圆点（左边缘紫点消失） |
| **按钮/渲染错乱** | 抽屉跟手手势重写：`pointerdown` 只记「待定」，横滑超过 6px 且明显大于纵向才进入 dragging，**纵滚不再改 dragOffset / 不再吞 click**（这正是「概率性点击没反应」的根因）；`swallowClickAt` 只在真正横滑后置位。行操作面板改成「抓手/标题拖动 + 6px 后才捕获指针」，`touch-action: pan-y`，长动作列表可以滚动。睡眠定时面板 `createPortal` 到 body，避免被带 `backdrop-filter` 的播放条当成 fixed 包含块 |
| **退后台 / 选文件 / 亮屏白屏重载** | 分析真机现场：安装包 `assets/` 只有 `devUrl`，页面脚本是 `/@vite/client` + `/src/main.tsx`，`navigation.type=reload` 后拉不到 `src/views/local/index.tsx` → Router 默认错误页。**先出 bundled `--debug` APK**；代码侧：看门狗去掉 10s 自动 `location.reload()`（改为只提示 + 手动重载）、加 `data-ready` 与「构建形态/导航类型/页面地址」诊断；根路由加 `errorElement`（chunk 失败不再白屏）；Manifest 补 `density/fontScale/navigation/layoutDirection/colorMode/mcc/mnc/touchscreen` + `alwaysRetainTaskState`；`MainActivity` 设 `RENDERER_PRIORITY_IMPORTANT`、主题底色、`onResume` 只发 `gently:app:resume` 事件（不 reload） |
| **启动白屏 / 品牌 logo** | `index.html` 内联品牌启动屏（`/logo.svg` 居中、不写项目名、深色跟随 `prefers-color-scheme`），React 双 rAF 后淡出；Android 启动窗口底色同步（`boot_background`，浅/深两套）。移动 bundle 6.7 MB、主 JS 553 kB（gzip 183 kB），启动屏覆盖解析空档 |
| **本地音乐目录扫描** | 新增 `import_audio_dir` 宿主命令 + Kotlin `pickDirectory`（`ACTION_OPEN_DOCUMENT_TREE` + `DocumentsContract` 递归，深度 ≤12、文件 ≤5000），复用同一套 `importUris` 拷贝/进度/扩展名筛选；本地页加「扫描目录导入」 |
| **背景图/视频铺满与坐标** | `BackgroundOptions` 加 `fit: cover/contain/fill`、`positionX/positionY`（0–100）、`scale`（1–2.5）；`BackgroundVideo` 同时支持 `<video>` 与 `<img>`（MIME/扩展名判断），内联 `object-fit/object-position/transform`；设置页三项滑杆；导入接受 jpg/png/webp/gif/avif |
| **宠物行为=动画** | pet-core 新增 `Motion{none,walk,crawl}` + `Animation.motion` + `Frame.motion`，旧包不声明仍全 `walk`（零回归）；`walking` 指向 `motion:none` 或没有任何可位移动画 → 安装期 `pet.invalid_package`；`Engine::motion(id)` 同进程给宿主门控，`pet_watch` 被挡时先发方向等动画切换、连续 6s 给不出可位移动画才放弃；内置包 9 个动作声明 motion，walking 行为提到 hungry 之前，版本 1.1.0 |
| **宠物养成** | `PetGrowth` 落 `state_json`（零 schema 迁移）：xp/feeds/touches/bestAffection/streakDays/daysVisited/today*；等级由只增 xp 派生；不饿时喂食不加好感；触摸/喂食每日收益上限；到档/里程碑解锁；`pet.state`/`pet.interact` 返回 `growth`；悬停状态卡与设置宠物行显示 Lv/经验/连续天数 |
| **概率性点击无响应** | 见上：抽屉纵滚误吞 click（已修）、行操作 pointer capture（已修）、睡眠面板被困在播放条（已 portal）。`data-overlay` 共用标记仍留作下一轮排查项 |
| **封面背景占比** | 迷你播放器（`shellMode=mini`）与手机共用内容表面不透明度下限 0.92、内容虚化 0：壁纸还在，但不再把人像照片铺满整个播放器 |
| **歌词页音频律动** | 重写 `AudioOscillogram`：从 `audioEngine.ensureAnalyser()` 取当前媒体元素的 `AnalyserNode`（**只在 AudioContext running 时接线**，suspended 就退回一条直线，绝不把正在播的声音改道到静音图里）；颜色读 `--brand/--divider`；36px 高、半透明、reduced-motion 不跑。`examples/test.html` 的波形/静音判定/增益保留 |
| **MusicFree 插件适配** | `parse_index_any` 识别 `{desc,plugins:[{name,url,version}]}` 并归一化为自有索引（fileName 从 URL 派生、冲突去重）；订阅面板预览失败后**自动多试一次 compat**（仍需用户勾选安装）；沙箱 compat 模式下 `search` 补第三参数 `type=music`、`getAlbumInfo` 补页码。**不内置任何列表地址**（用户自己粘贴） |
| **完善宠物养成**（扩展） | 本轮只做「最小档 + 每日/连续 + 解锁展示」；道具/库存/每日任务/成就/作息/多宠物 UI 未做，明确留在下一轮 |

### 2. 验证

| 项 | 结果 |
|---|---|
| `pnpm typecheck` | 通过（修掉了用户原有的 `AudioOscillogram` 空壳报错） |
| `pnpm smoke` | **589 项全过**（R137 的 578 → +11：目录导入、背景选项、宠物 motion/成长、主页配置等） |
| `pnpm check:contract` | 76 命令 / 9 事件 / 26 错误码 / 7 宠物命令 全一致 |
| `pnpm check:reachability` | 230 服务节点 / 99 动作节点，全部可达 |
| `cargo test -p pet-core` | 16 个测试目标全过（新增 `motion.rs` 6 条、`growth.rs` 7 条） |
| `cargo test -p gently` | 9/9（含 `walk_decision` 门控） |
| `cargo test -p gently-core -j 2` | 全过（并行度太高时本机链接会出 E0463，`-j 2` 稳定） |
| `pnpm verify` | **全绿**（typecheck / smoke / 契约 / 可达性 / core / 宠物独立性 / pet-core / 宿主单测） |
| Kotlin | `:app:compileArmDebugKotlin` BUILD SUCCESSFUL（新版 ImportPlugin / MainActivity） |
| 移动构建 | `TAURI_ENV_PLATFORM=android pnpm build` 成功；`dist` 6.7 MB、无 dev 脚本、无 100 MB 演示视频 |
| bundled APK | `CARGO_PROFILE_DEV_DEBUG=0 pnpm tauri android build --debug -t aarch64 --apk -f tauri/custom-protocol` 成功；`release/gently-0.1.0-android-debug.apk`（81.2 MB debug，关 debuginfo；embedded `.so` 里有 `assets/index-*.js`、0 处 `src/main.tsx`、0 处 `bgc-`） |
| 真机 | **本轮无设备连接**（`adb devices` 为空）；「重载」真因来自上一轮真机现场证据，修复后必须装新 bundled APK 复测 |

### 3. 未做 / 下一步

- **必须装 bundled 包**：`CARGO_PROFILE_DEV_DEBUG=0 pnpm tauri android build --debug -t aarch64 --apk -f tauri/custom-protocol`，装 `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`（本轮已产出 `release/gently-0.1.0-android-debug.apk`，SHA256 `993fecab…`）。验收：页面脚本里不能出现 `/@vite/client` / `/src/main.tsx`。旧 dev 包无论怎么改代码都会在 reload 后白屏。
- **旧华为（WebView 92）的精确安全区**：`env()` 只给 display cutout；下一步加 Kotlin WindowInsets 命令 + `useSafeAreaInsets`（契约「桌面层命令」表 + Rust `window_insets` + 前端 `--safe-*`）。
- **MusicFree 完整兼容**：`cheerio` / AES / `big-integer` / `qs` 垫片、`getArtistWorks` / 评论 / 歌单导入都未做；现在只能跑「无清单外 require」的插件，预览会如实报缺少模块。
- **宠物爬行**：`crawl` 枚举与 `edgeOverhang` 几何口子已留，宿主的 `WALK_TARGET` 还是一维、事件 payload 仍是 ±1，贴边爬行未实装。
- **养成的「每日」按 UTC 日结算**（核心拿不到时区；UTC 0 点 = 北京时间 08:00）：本地日序号需要从前端 `pet.tick/state/interact` 传入，下一轮补。
- **点击问题**：`data-overlay` 仍是单一全局标记；抽屉面板空白处不关闭、`useBackToClose` 与导航抢历史仍会在极端时序下出问题，留待真机长测。

## 本轮目标（第一百三十八轮）

> 桌宠几何第二轮：① 宠物要能贴到屏幕四边——以后接 VPET 那种「贴边爬行」时，爬墙姿势得能挂到屏幕外，
> 窗口不能把本体锁在离边半扇窗的位置；② 控制面板 / 状态卡不该只会上下摆，宠物在左右两侧时放内侧更直观。
> 底线沿用上一轮：**卡片怎么摆都不能反过来限制宠物站在哪**。

### 1. 做法

| 层 | 改动 |
|---|---|
| 几何 `petWindowPosition.ts` | 窗口 = 本体 + 四边各 `PET_HUD_RESERVE(260) + PET_HUD_GAP(8)` 的**画布**，本体居中、四边等距（此前按脚底对称，上方只剩 `pad - 身高/2`，上方面板必被窗口上沿裁掉）。只夹**本体**，窗口允许越出屏幕；`edgeOverhang`（默认 0）允许本体再伸出若干像素，给爬边动画留位置 |
| HUD 槽位 | 独立摆放：本体离左右边 ≤ 卡片宽 + gap → 放**内侧**；否则上 → 下 → 左右，最后按剩余空间取大者。槽位贴本体边缘锚定、另一轴夹进屏幕，且始终整块在窗口画布内——面板放不下只影响面板 |
| 走动 `pet_watch.rs` | 目标与边界改按**本体**坐标（`body_screen_x` / `body_walk_range`），窗口按同一 delta 平移；窗口比本体大一圈也不会在离边半扇窗处停下 |
| 拖动 | 前端拖动继续走 `layoutPetWindow`，窗口跟手，HUD 同步换边 |

### 2. 验证（打包版，1920×1080，任务栏 48px）

| 项 | 结果 |
|---|---|
| 上方面板 | 窗口 (592,132) 743×761（本体 207×225 居中）；菜单六项 + hover 状态卡完整可见（不再被上沿裁） |
| 右下角 | 窗口 (1445,587) 743×761：本体盒右下角正好落在 (1920,1080)，菜单在左侧完整（`bottom-right-menu.png`） |
| 左上 / 右上 / 左下 | (−268,−268) / (1445,−268) / (−268,587)：本体到角，面板在内侧完整；窗口整块出屏也没关系 |
| 右边缘 | 窗口 (1445,555)：本体盒右侧正好 1920，菜单 / 状态卡自动落到左侧，完整可见 |
| 拖动 | dx=−120 / dy=−72，窗口 1:1 跟手，HUD 跟随换边 |
| 走动 | 光标移开后自动恢复（4 张走路截图）；边界按本体算，不会提前停 |
| 大小 | 小 640×648 / 中 743×761 / 大 847×873；大号菜单在下方仍完整 |
| 喂食 / 隐藏 | 「好吃！」正常；隐藏后窗口 `visible=False`，`petEnabled` 回到 false（设置页显示禁用），走动的持久化开关恢复原状 |
| 守卫 | `smoke` 588/588；`cargo test -p gently` 8/8（含 `walking_moves_the_pet_not_the_window`）；契约 76 命令 / 9 事件；`check:pet`、`check:reachability` 通过。`typecheck` 仍只剩用户原有的 `AudioOscillogram.tsx` 报错 |

### 3. 未做 / 下一步

- `edgeOverhang` 只是几何入口：贴边吸附、爬墙姿势与状态机还没做（等动画素材）。
- 打包坑：普通 `cargo build` 出的是 dev 宿主（嵌 `devUrl`），宠物页永远挂不上、窗口停在 200×160；
  出包必须带 `--features tauri/custom-protocol`（GOTCHAS §73）。
- 便携包已用新 exe 重打（`release/gently-0.1.0-windows-x64.zip`，SHA256 `d9a91695…`）；
  `release/gently-0.1.0-windows-x64/data` 保留原样（打 zip 时临时挪开再放回）。

## 本轮目标（第一百三十七轮）

> 用户报了 5 条移动端问题：后台播放失效 / 抽屉不能滑动打开 / 点抽屉导航项有时没反应（「设置页改设置白屏」的现场）/
> 歌词页的返回按钮应该去掉（交给系统返回）/ 列表的「卡片」观感不符合主流。

### 1. 逐条处理

| 问题 | 结论与改动 |
|---|---|
| **后台播放** | 找到并修掉两处「自己把后台播放搞死」的代码：① 后台恢复走 `resume()`，它失败就 `reload()`——每 5 秒一次，进度被反复清零（熄屏 150s 只走了 13s）；改成只 `nudge()`（裸 `play()`，不重载、不报错）；② 看门狗 2.5s 判「媒体元素没有开始播放」时页面隐藏也照判（后台定时器被系统延后，很容易把正常播放判死）——隐藏时不判，僵死留给回前台。**负结果**：给 `PlaybackService` 加 `requestAudioFocus(AUDIOFOCUS_GAIN)` 反而让**播放起不来**——Chromium 自己持有焦点（`dumpsys audio` 能看到 `AudioFocusDelegate`），服务再抢一次会让 WebView 收到 LOSS 并暂停；已回退。另加页面侧 `navigator.mediaSession` 元数据/播放态（Chromium 据此认定「这是后台媒体」，没有该 API 就静默跳过）。**真机：Home+熄屏 75s → 进度 12→97，仍在播** |
| **抽屉滑动打开** | `MobileShell` 加横滑手势：起手点离屏幕左边 ≥ 48px（避开系统返回手势区——R124 的负结果），横向位移 ≥ 72px 且明显大于纵向才触发；`.content` 设 `touch-action: pan-y`；播放条标 `data-drawer-swipe="off"`（进度条自己就是横向拖动）；滑动后 **300ms 内**那一次 click 被吃掉（只吃这一下，不能把抽屉里紧接着的点击一起吞了） |
| **抽屉导航项有时没反应** | 真机复现：冷启动后第一次「抽屉 → 设置」必失败。根因是 `useBackToClose` 收起时的 `history.back()` 与抽屉里的 `navigate()` 抢同一条历史（`navigate` 在 RouterProvider 里**异步落地**）。修：hook 返回「这次别动历史」的句柄，抽屉换页改为 `navigate(path, {replace: 标记存在})` 直接顶掉标记——页换了、历史不多一条。真机复测：冷启动第一次即成功，连续 8 次 0 失败、历史每次只增 1 |
| **设置页改设置白屏（真因已定位并修复）** | 用户澄清：**没有异常**，只有白屏 + 回不来。真机量出来是**外壳 `.app` 被浏览器滚走了**：`overflow: hidden` 只表示「不显示滚动条、不接受手指滚动」，**仍然是可编程滚动的容器**；点「分源（按音源分别展示）」这种长标签时会聚焦那个隐藏的 radio，浏览器为了露出它会把所有可滚祖先（包括 `.app`）滚过去——`main.scrollTop=1647` **且** `app.scrollTop=1653`（`app.scrollHeight=3235` vs `clientH=889`），整个外壳被顶出屏幕，剩下的就是一片白；而 hidden 不接受手指滚动，用户**再也滚不回来**（横向同理：`scrollLeft=48.5`、卡片左边被顶到 -37px）。修：① 新 hook `useClampedShell()` 给三个外壳（手机/迷你/桌面）都挂上「滚了就归零」（两个方向，另加捕捉阶段的 `focusin` 兜一次）；② 长选项换行（`UnderlineRadioGroup` 的 `.root` 与设置页 `.value` 都 `flex-wrap` + `max-width:100%`，不再撑破卡片）；③ 内容区 `scrollLeft` 也钳回 0、换页时两个方向都归零。另保留白屏看门狗（三种形态 + 诊断 + 一次自动重载）作安全网 |
| **歌词页返回按钮** | 手机形态不再渲染「返回」（桌面保留——那边没有系统返回）。真机：`/now-playing` 的按钮只剩「封面作为背景 / 歌词工具」，系统返回 `/now-playing` → `/setting` → `/search` 逐级退回 |
| **列表卡片观感** | 手机列表拆掉外层卡片：容器去掉边框 / 圆角 / 白底，行只留 1px 分隔线、底色交给页面（`.container[data-layout='mobile']`；容器也带 `data-layout`，因为 WebView 是 Chromium 92，不能用 `:has()`）。补回「播放中的行」底色（新规则特异性更高会盖掉 `.row.active`） |

### 2. 验证（真机 `CDY-AN00`）

| 项 | 结果 |
|---|---|
| 滑动开抽屉 | `input swipe 250 1000 800 1000 220` → 抽屉打开；在播放条上横滑（y≈2280）**不打开**（`data-drawer-swipe="off"` 生效） |
| 抽屉导航 | 冷启动第一次「设置」即生效；连续 8 次来回 0 失败，历史每次 +1（不再留标记垃圾） |
| 歌词页 | 无「返回」按钮；系统返回逐级退回（`/now-playing` → `/setting` → `/search`） |
| 列表 | `release/screenshots/r137-mobile-list-flat.png`：列表直接铺在页面上，无卡片外框 |
| 后台播放 | Home + 熄屏 75s：进度 12 → **97**（+85s，仍在播）；再跑 180s：进度 4 → **195**（+191s，仍在播，已越过 R111 记的 2.8 分钟门槛） |
| **白屏真因（真机 A/B）** | 修复前：设置页 `app.scrollHeight=3235 / clientH=889`、`app.scrollTop=1653`，`adb screencap` **15 KB 纯白**；修复后：同一操作 `app.scrollTop=0 / scrollLeft=0`、`main` 正常滚动（1841）、长标签换行、`adb screencap` **209 KB**（页面正常可见），`perChecked` 照常切换。连续 4 次真实点击切换：`scrollLeft` 始终 0、`scrollWidth==clientWidth`、卡片 `left=12/right=380` 不变 |
| 白屏看门狗 | 真机模拟两种白屏都被抓到：`#root.style.display='none'` → 「判定：#root 的 display 是 none」；注入 `* { color: #fff } + body { background: #fff }` → 「判定：文字与背景几乎同色（例：SPAN「probe」rgb(255,255,255) on rgb(255,255,255)）」；正常页面（`/search` 49 字、`/recent` 113 字）不误报。截图 `release/screenshots/r137-blank-watchdog.png` |
| 门禁 | `pnpm typecheck`；`pnpm smoke` **578**（566 → +12）；契约 76 命令未变 |

### 3. 未做 / 下一步

- **后台播放**：本轮从「一退后台就停」修到「熄屏 75s 继续播」。若仍有长时（>5 分钟）失效，先看 logcat 有没有 `HwMedia::Play hbs_autoplay_ = 0`（华为 WebView 自己的后台自动播放门禁）。**不要**再给 `PlaybackService` 加 `requestAudioFocus`：Chromium 已持有焦点，抢一次会让播放起不来（GOTCHAS §70）。原记录：
  `PlaybackService` 的 `MediaSession` 主动 `AudioManager.requestAudioFocus(AUDIOFOCUS_GAIN)`（暂停/停止时 abandon），
  让系统认为音频归本应用所有；另一条是页面侧维护 `navigator.mediaSession`（Chromium 据此判定「这是后台媒体」）。
  两条都要真机长测（≥5 分钟、含息屏），下一轮做；
- **设置页白屏**：本机复现不出（且**没有异常**，所以只能靠主动检测）。请装最新包后再切一次「列表展示方式」：出现白色空白约 2 秒后，底部会弹出「界面看起来是空白的」横幅——点**复制诊断信息**发我，里面已含判定原因与 DOM/配色/偏好快照；
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
|---|---|---|---|
| R142 | 主窗口 12 秒不可见：Low 完整性级别的真因 | 运行中 `gently.exe` 令牌 `S-1-16-4096`（Low）；工作区/exe Low；无 `msedgewebview2.exe`；`EBWebView` 未更新；当天日志缺失。根因是 `NEW_PROCESS_MIN` 把 Low exe 的子进程保持 Low，Low 写不了 Medium 的 WebView2 profile/AppData。新增 `integrity.rs`、Low 专用启动提示、`scripts/check-integrity.ps1`；GOTCHAS §78。**待用户从普通 PowerShell 启动验收** | [本轮](#本轮目标第一百四十二轮) |
| R141 | 用户反馈批次：手机返回栈 / 宠物首帧 / 长暂停恢复 + 9 条优化 | 手机播放条复用 `shouldOpenNowPlaying`；宠物首帧隐藏到图集就绪；`playOrToggle` 统一走 `toggle` 并在长暂停后重解析；随机播放、手机 4 功能位 + 抽屉；歌词偏移滑杆/输入；宠物 64–480px；下载落盘唯一化；目录导入可选递归；浅色降亮 + 夜间柔光；定时关闭 1–720 分钟。typecheck / smoke 597 / 下载测试 7 通过 | [本轮](#本轮目标第一百四十一轮) |
| R137 | 移动端反馈批次：后台播放、滑动开抽屉、导航项点不动、歌词页返回、列表去卡片、白屏兜底 | ① 后台播放：抓到现场是华为 WebView 在页面不可见时拒绝 `play()`（`Hbs autoplay=0`）；修掉「后台 resume()→reload() 每 5s 清零进度」（熄屏 150s 只走 13s）改成只 `nudge()`，看门狗在隐藏时不判失败。② 抽屉横滑打开：起手离左边 ≥48px、位移 ≥72px、播放条排除、只吃紧接的 click。③ 抽屉导航偶发没反应：`history.back()` 与异步 `navigate` 抢历史 → 换页用 replace 顶掉标记 + hook 返回「别动历史」句柄；冷启动首次即成功、8 次 0 失败。④ 白屏本机未复现，加 `RouteError` 错误边界（出错只坏内容区 + 可反馈的出错信息）。⑤ 手机歌词页去掉「返回」，靠系统返回。⑥ 手机列表拆外层卡片改连续列表。smoke 575 | [本轮](#本轮目标第一百三十七轮) |
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
