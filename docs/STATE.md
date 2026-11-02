---
status: active
last_verified: 2026-11-02
owner: gently
scope: 当前迭代状态与下一步
token_budget: 250
tldr: 当前 R134（用户反馈 10 条的收口复核，#5 动画穿模落地+真机实测）：R133 的「浮层打开时压住底层按压态」在真机上量出两处问题——① 规则越界到浮层自身（抽屉项/面板动作按钮的按压反馈会被一起压掉，代码层判定）；② 行规则与 `.table[data-layout='mobile'] .row:active` 同权重 0,4,0，平局靠源码顺序，真机上只压住了过渡没压住背景色。修：抑制收窄到顶栏 + 内容区按钮，行的覆盖写进 DataTable 并用 `html` 提到 0,4,1。真机复核（`CSS.forcePseudoState` 强制 `:active` + `getAnimations()`）：顶栏/行/⋯ 全透明、抽屉项与面板动作按钮保留 `--bg-active`、浮层打开后浮层外 0 条动画、标记随开关清理。smoke 555。**用户 10 条体验反馈至此全部落地**（#1 只剩左边缘横滑这一负结果，被系统返回接管）。
---

# STATE

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

## 本轮目标（第一百三十三轮）

> #5 动画穿模的**第一刀**：浮层（抽屉 / 行操作面板）打开时，底层元素的按压态与过渡还在跑，
> 透过遮罩看着像「两层同时在动」。

### 1. 改动（最小可回退）

| 文件 | 改动 |
|---|---|
| `hooks/useBackToClose.ts` | 浮层打开时给 `<html>` 打 `data-overlay="open"`，关闭时删掉——这个 hook 本来就被抽屉与底部面板共用，标记只在一处维护 |
| `MobileShell.module.css` | 新增 `:global([data-overlay='open'])` 规则：抑制底层 `button:active` / 行 `:active` 的高亮与过渡（`background-color: transparent` + `transition: none`） |

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**555**；
- **真机复核未做**（本轮只到门禁这一层）：需要真机开抽屉/面板、按住底层按钮截图对比。
  按前几轮的标准，这条先记为「已落地、待真机确认」。→ **R134 补上了真机复核**（并修掉规则越界与行的特异性平局）。

### 3. 未做

- 若真机上仍有穿模，下一刀在层级侧解决（把播放条那层的动画整体裁掉/加 `isolation`）；
  → R134 量到浮层外 0 条动画，**这一刀不需要了**；
- 文案与其它 9 条不变。

## 本轮目标（第一百三十轮）

> #10 的尾项：手机上已经隐藏「下载目录 / 数据目录」这类本机路径，但下载卡片只剩
> 「并行数 / 音质」，用户不知道文件到底落在哪。

### 1. 改动

- `views/setting/index.tsx`：下载卡片在手机形态多一句
  `page.setting.downloadDirMobileHint`（「下载与缓存都落在应用私有目录（由系统管理），卸载应用会一并删除。」），
  与数据目录卡片的说法保持一致；桌面端仍显示目录输入框。
- i18n：`page.setting.downloadDirMobileHint`（zh + en）。

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**555**（i18n 死键守卫通过，新键被引用）。

### 3. 未做

- **#5 动画穿模**（唯一完全未开始的一项）：需要真机复现 + 改层级/抑制底层按压态，留下一轮。

## 本轮目标（第一百二十八轮）

> #3 的最后一项：设置页背景卡在手机形态仍提供「网页（静态单文件）」类型
> ——那是把单个 HTML 塞进 iframe 的桌面玩法，手机上素材难准备、还白白吃内存。

### 1. 改动

- `views/setting/components/background-card.tsx`：背景类型选项按 `isMobilePlatform()` 分流，
  手机形态只有「视频」；桌面端两种都在（`onChange` 保持原样，历史配置不会被清掉）。

### 2. 验证

- `pnpm typecheck` 通过；`pnpm smoke`：**555**（i18n 死键守卫通过——`kindWeb` 仍被桌面分支引用）。

### 3. 未做

- **#5 动画穿模**（唯一未开始的一项）、#10 下载卡片说明文案。
- 本轮无真机视觉复核（只改选项列表、无原生无样式），下一轮与 #5 一起在真机核对。

## 最近三轮

| 轮次 | 主题 | 结论 | 详情 |
|---|---|---|---|
| R134 | #5 动画穿模：真机复核 + 修 R133 的两处偏差 | 强制伪类 + `getAnimations()` 量出：① 行规则与 `.table[data-layout='mobile'] .row:active` 同权重（0,4,0），平局靠源码顺序 → 真机上只压住过渡、没压住背景色；② R133 的全局 `button:active` 越界到浮层自身。修：抑制收窄到顶栏 + 内容区按钮（`html[data-overlay='open']`），行的覆盖写进 `DataTable.module.css` 并提到 0,4,1。真机：顶栏/行/⋯ 全透明、抽屉项与面板动作按钮保留 `--bg-active`、浮层外 0 条动画、标记随开关清理；smoke 555 | [本轮](#本轮目标第一百三十四轮) |
| R133 | #5 动画穿模第一刀：浮层打开时压住底层的按压态 | `useBackToClose` 打开时给 `<html>` 打 `data-overlay="open"`（抽屉与底部面板共用这一个 hook，标记只在一处维护）+ CSS 抑制底层 `:active` 高亮与过渡。交付时只到门禁（smoke 555），真机复核留给 R134 | [本轮](#本轮目标第一百三十三轮) |
| R130 | #10 尾项：手机上下载落在哪 | 下载卡片在手机形态多一句 `page.setting.downloadDirMobileHint`（「落在应用私有目录、卸载一并删除」），与数据目录卡片说法一致；桌面仍显示目录输入框。smoke 555 | [本轮](#本轮目标第一百三十轮) |
| R128 | #3 尾项：手机形态不再提供「网页（静态单文件）」背景 | 背景类型按 `isMobilePlatform()` 分流（手机只有「视频」），桌面两种都在、历史配置不清理。smoke 555 | [本轮](#本轮目标第一百二十八轮) |

## 历史轮次

- R01–R83：[`archive/rounds/R01-R83.md`](archive/rounds/R01-R83.md)
- R84–R88：[`archive/rounds/R84-R88.md`](archive/rounds/R84-R88.md)
- R89–R100：[`archive/rounds/R89-R100.md`](archive/rounds/R89-R100.md)（宠物从 M0 到 1.0 的全过程；R99/R100 为摘要）
- R101–R117：[`archive/rounds/R101-R117.md`](archive/rounds/R101-R117.md)（桌面收尾 + 宠物 1.0 + 安卓 P0–P4 共 17 轮正文）
- R118–R126：[`archive/rounds/R118-R126.md`](archive/rounds/R118-R126.md)（安卓 P3 余项 + 用户 10 条体验反馈的收口批次：手势、歌词页、桌面专有项、背景与重影、过渡）

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
   导入进度条、音乐目录导出）。
2. **R110 留下的小任务**：把「上游返回的不是音频」变成用户能看懂的文案（`playback.resolve` 里先探一次并自动换候选，
   或加一条契约事件），别只留在日志里（GOTCHAS §56）。
3. **宠物 M4 / 玩法打磨（随时可做、可暂缓）**：移动端渲染器（核心层已独立，见 ADR 0010）；`minPetCoreVersion`
   真版本比较、atlas 瘦身（1.5 MB）、走路避让窗口/任务栏、多宠物 UI（存储与 API 已预留）、逐像素 alpha 命中。
   触发条件是安卓决定做宠物。
4. **工程债**：`GOTCHAS.md` 64 条按域拆分（现在是一份长表，查起来靠搜索）；截图证据改成「seeded 数据 + 可深链 +
   固定浅/深基线」，不再靠手算坐标（真机这半已由 `scripts/android-cdp.mjs` 解决）；拖动/悬停这类**注入式输入
   验证不了**的交互，补一份人工验收清单。
5. 背景 P2（带 JS / 多文件网页壁纸）与迷你歌词视觉细调仍挂着，未排期。
