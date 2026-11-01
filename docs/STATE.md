---
status: active
last_verified: 2026-11-01
owner: gently
scope: 当前迭代状态与下一步
token_budget: 250
tldr: 当前 R106（完善 pet-core）：把三处「声明了但不生效」的地方做成真的 —— ① `minPetCoreVersion` 现在**真的比较**（新错误码 `pet.incompatible`，界面有 zh/en 文案），`version` 必须能解析；② `Condition::SilentFor{ms}` 以前等于「没在播就算」，现在真的按静默时长判断（播放一恢复就归零）；③ 打断型动画（点击/换歌）**必须演完一遍**再让状态机接管，否则「点一下抖一下」；另外 `pet.json` 原文限 512 KiB、`pet.state` 带 `coreVersion`（调试面板可见），宠物错误码全量本地化并由 smoke 守卫。**安卓已重启并跑通 P0**（用户 2026-11-01 决定）：arm64 debug 包已装真机、核心日志与界面都有证据，计划见 `docs/ANDROID-PLAN.md`。核心 75 命令；smoke 509；宠物 **72** 项测试（+宿主 5 项）；verify **8** 道全绿。
---

# STATE

## 本轮目标（第一百零六轮）

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
| R106 | 完善 pet-core | 三处「声明了但不生效」做成真的：`minPetCoreVersion` 真比较（新码 `pet.incompatible`）、`SilentFor` 真计时、打断型动画演完一遍；`pet.json` 限 512 KiB；`pet.state` 带 `coreVersion`；宠物错误码全量 zh/en + smoke 守卫；smoke 509 / pet-core 72 | [本轮](#本轮目标第一百零六轮) |
| R105 | 拖动自绘 / 尺寸归一 / 衔接 | 拖动改成渲染器自己搬窗口（可播拖动动画，注入式输入能验证了）；`animations[].fit` 把各行素材缩放对齐；动画切换加 160ms 确认期 + `play.interrupt`，走动暂停加迟滞；smoke 508 / pet-core 58 | [下方](#第一百零五轮) |
| R102 | 走动 + 拖动修复 | 宿主每 60ms 挪窗口、核心按 `walking{dir}` 挑 `runLeft`/`runRight`（设置页开关，默认关）；拖动失效的根因是自动穿透只登记了精灵 → 改成多块可交互区域 + 本体拖动；修掉位置记忆被程序摆放污染 | [下方](#第一百零二轮) |

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
3. **安卓（进行中）**：用户 2026-11-01 决定重启，形态定为**同一仓库 `src-tauri/gen/android`**、
   验收用**真机 USB**（`CDY_AN00` · API 29 · arm64）。**P0 当天已跑通**：NDK r28c + 4 个 target +
   `gen/android` + arm64 debug APK 装机启动，真机日志 8 条迁移 / `数据库就绪 version=8` / `宠物核心就绪`，
   界面渲染出迷你播放器空态。拦路虎 `rquickjs-sys` 缺 android 绑定已用 **vendored patch** 解决
   （GOTCHAS §48）；新踩的坑见 §50–§52（多窗口→白屏、dev 包不含资源、取证与数据目录）。
   计划与执行记录在 [`ANDROID-PLAN.md`](ANDROID-PLAN.md)（§6 有逐条证据），自检
   `pwsh -File scripts/android-env.ps1`。**下一步 P1（移动外壳）**，等用户确认。
4. **工程债**：`GOTCHAS.md` 47 条按域拆分；截图证据改成「seeded 数据 + 可深链 + 固定浅/深基线」，不再靠手算坐标；
   拖动/悬停这类**注入式输入验证不了**的交互，补一份人工验收清单。
5. 背景 P2（带 JS / 多文件网页壁纸）与迷你歌词视觉细调仍挂着，未排期。












