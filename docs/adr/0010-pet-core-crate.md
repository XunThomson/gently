---
status: accepted
last_verified: 2026-10-31
owner: gently
scope: pet-core：宠物系统的独立核心引擎（第五部分设计稿 + M0 地基）
token_budget: 1400
tldr: 宠物抽成**独立 crate `pet-core`**：自己的 SQLite 库、不依赖 `gently-core`、不依赖 tauri。两个引擎（音乐 / 宠物）各自被宿主消费，UI 只是当前的宿主（Tauri + React），可替换；将来宠物可独立成仓库/应用。音乐软件里**同时只展示一只**宠物，但存储与 API 按「多只」设计（为独立化预留）。喂食/好感度这类**跨会话状态**现在只建地基（字段 + 衰减 + 冷却 + 持久化 + 测试），玩法数值与交互 UI 留后续。M0 已落地（crate + 10 项单测 + 独立性守卫）。
---

# ADR 0010：pet-core —— 宠物独立成 crate（与音乐核心并列，不耦合）

## 背景

宠物在代码里此前只是一个**空的扩展点**（`src/pet/`：`PetDefinition.mount(container, ctx)`、
只读播放快照、`PetHost` 无宠物时渲染 null），边界由
[ADR 0007](0007-versioning-and-pet-extension.md) 定下：纯本地、只读播放状态、不联网、不上报。

现在要**预开发**宠物（音乐软件仍在 1.x）。早期草案里有一处方向性错误，已被用户否决并纠正：

- ❌ 旧草案：「`pet-core` 只做纯状态转移，**存储归 music core**」。
- ✅ 正确边界：**`pet-core` 是独立 crate，带自己的数据库**。把宠物养成塞进音乐核心，等于把两个
  完全不同的领域强行耦合——以后既不能单独发布宠物，也没法换掉 UI。两者的关系是：
  **`gently-core` 是音乐软件的数据处理引擎，`pet-core` 是宠物系统的核心引擎；两者都只被宿主消费，
  互不依赖**。当前宿主是 Tauri + React（渲染），但宿主是可替换的：Rust 核心相对稳定，
  UI 库仍在演进，将来换 UI 框架（甚至把宠物做成独立应用）时两个 core 都不用改。

参考项目 [VPet](https://github.com/LorisYounger/VPet) 也验证了这个形态：它把宠物做成可嵌入的
`VPet-Simulator.Core` 库，宿主（WPF）只负责画。我们借「core 库 + 宿主 UI」分离与行为模块化，
**不借**它的 WPF 专属渲染与 .NET 程序集 MOD 体系（那等价于「宠物可执行任意代码」，与 ADR-0005/0006 冲突）。

## 决策

### 1. 三个边界（硬约束，机械校验）

```
        ┌─────────────── 宿主（现在：Tauri + React；可替换）───────────────┐
        │   src-tauri（命令适配，M1）        src/pet（渲染适配器）           │
        └───────▲────────────────────────────────────▲────────────────────┘
                │ 调 Rust API                        │ 消费 Frame / 资料
        ┌───────┴────────┐                   ┌────────┴─────────┐
        │  gently-core   │  ← 互不依赖 →      │    pet-core      │
        │  音乐数据引擎   │                   │  宠物核心引擎     │
        │  gently.db     │                   │  pet.db（自己的） │
        └────────────────┘                   └──────────────────┘
```

1. **不依赖音乐核心**：`pet-core` 不得出现 `gently_core`、不得依赖 `../core`；
   反向也不许（`gently-core` 不依赖 `pet-core`）。宿主可以做转换（把 `Track` 变成
   `PlaybackHint`），但两个 core 之间没有代码依赖。
2. **不依赖 UI**：`pet-core` 不得依赖 `tauri`；它只产出纯数据（`Frame` / `PetProfile`），
   谁画都行。
3. **数据独立**：自己的 SQLite 文件 `pet.db`（目录由宿主传入，当前是 `<data>/pet/`），
   自己的 schema 与迁移，不碰音乐库。

这三条由 `scripts/check-pet-independence.mjs`（`pnpm check:pet`，也在 `pnpm verify` 里）**每次验证时机器检查**，
不靠人记。

### 2. 单宠物展示，多宠物预留

- 音乐软件里**同时只展示一只**（`Engine::active_pet()`，持久化在宠物库的 `meta` 表）；
- 但**存储与 API 按多只设计**（`pets` 表多行、`install/list/remove/set_active` 都带 id），
  因为宠物后期可能独立成一个仓库/应用，那时「多只并存」是自然需求，不能等到拆分时才改数据模型；
- 界面上没有「多宠物」入口（现在也没有任何宠物入口，见 §6）。

### 3. 跨会话状态：先建地基

用户明确：**喂食、好感度这类跨会话状态要做，但不是现在**——先建立地基。M0 落地的地基包含：

| 地基项 | 落点 | 说明 |
|---|---|---|
| 资料字段 | `PetProfile{affection, hunger, last_fed_at, last_touched_at, created_at, updated_at, state_json}` | `state_json` 是给后续「行为状态」留的扩展位，不改表就能加 |
| 随时间衰减 | `PetProfile::decay(now_ms, limits)` | 离开越久越饿、好感越掉（每小时 2 点 / 12 点，集中在 `PetProfileLimits`） |
| 交互 API | `Engine::feed/touch` | 喂食有冷却（拒绝并说明还剩多少毫秒）；摸一下冷却内**静默忽略**（摸两下不该弹错误） |
| 持久化 | `pet.db` 的 `pets` 表；`tick` 每 200 帧写回 + 交互立即写 + `flush()` | 写后置：不每帧写盘，也不丢太多 |
| 结算时机 | `Engine::runtime_mut` 每次进入都结算一次时间流逝 | 防止「应用挂着不动」时衰减永远不生效；结算后把 `updated_at` 推到 now，避免重复计 |
| 玩法数值集中 | `PetProfileLimits` | M0 只给保守默认；做玩法时只改这里，不动存储与状态机 |

**没有**做（等后续里程碑）：喂食的 UI 与动画反应、好感度分档的表现（高兴/生气）、饥饿对行为的实际影响、
「养成」相关的成就/事件。`Sim::tick` 已经留了 `profile` 参数，将来加条件不必改宿主。

### 4. 接口（M0 已实现，M1 才接宿主）

```rust
// pet-core（无 UI、无平台依赖、确定性）
pub struct Engine;
impl Engine {
    fn open(root: impl AsRef<Path>) -> PetResult<Self>;         // 宿主给目录
    fn install(&mut self, spec_json: &str, now_ms: u64) -> PetResult<PetSpec>;
    fn list(&self) -> PetResult<Vec<(PetSpec, PetProfile)>>;
    fn active_pet(&self) -> Option<&str>;
    fn set_active(&mut self, id: &str) -> PetResult<()>;
    fn tick(&mut self, id: &str, input: &Input, now_ms: u64) -> PetResult<Frame>;
    fn feed(&mut self, id: &str, now_ms: u64) -> PetResult<PetProfile>;
    fn touch(&mut self, id: &str, now_ms: u64) -> PetResult<PetProfile>;
    fn remove(&mut self, id: &str) -> PetResult<bool>;
    fn flush(&mut self) -> PetResult<()>;                        // 退出/切宠前写回
}

pub struct Input { dt_ms: u32, playback: PlaybackHint, pointer: Option<(i32,i32)>, clicked: bool }
pub struct Frame { animation: u16, frame: u16, x: i32, y: i32, flip: bool,
                   bubble: Option<u16>, hit_area: Option<Rect> }   // 定长、Copy、无分配
```

- **确定性**：同样的初始条件 + 同样的 `Input` 序列 → 逐帧相同的 `Frame`（自带 xorshift，种子固定）；
- **零分配**：气泡是文案表下标（`Sim::text_key(i)` 取键，文案由宿主的 i18n 解析），`Frame` 是 `Copy`；
- **无副作用**：不读时钟、不写播放器、不碰网络；时间与播放快照都由宿主喂进来。

### 5. 宠物包：数据包，不是代码

```
my-pet/
  pet.json     # PetSpec：id/name/version/author/atlas/animations/behaviors
  atlas.png    # 精灵图（唯一允许的素材类型：png/webp）
  atlas.json   # 帧切分（可选）
```

- 行为是 `Condition → Action` 的**有限枚举**（`idle/playing/silentFor/lyricActive/pointerNear/clicked/trackChanged`
  → `play/say/face/anchor`），**没有表达式求值、没有 JS**；
- 沿用 R87 主题包已经踩过的规则：素材不进 JSON、`atlas` 只能是**纯文件名**、体积/帧数/动画数有上限
  （`MAX_PACKAGE_BYTES = 8 MiB`、`MAX_FRAMES_PER_ANIMATION = 512`、`MAX_ANIMATIONS = 32`）、
  导入仍是「预览 → 用户显式同意 → 安装」；
- 校验失败给**可读原因**（指出具体动画名 / 字段），不用一句「宠物包非法」糊过去。

### 6. 现在不上产品界面（仍是 1.x）

- 宠物**不出现在任何界面**：`PetHost` 保持「没有注册宠物就渲染 null」；没有侧栏入口、没有设置项；
- 渲染/命令桥属于 M1，等 M0 稳定后再做；届时用 `appConfig` 或构建开关控制可见性，避免 1.x 用户看到半成品。

## 与 ADR 0007 的关系

ADR 0007 定的边界**继续有效**：纯本地、不上报、只读播放状态、无宠物商店、性能预算、用户导入的宠物不得绕过插件权限。
本 ADR 只**强化**它：把宠物从「前端扩展点」升级为「独立引擎」，并把「数据归谁」明确为宠物自己。

## 备选方案与不选的理由

1. **保持前端扩展点（全部写在 `src/pet`）**：行为无法确定性测试、Android/其它宿主端要重写、社区无法贡献宠物包。
2. **存储放 music core（旧草案）**：用户已否决——两个领域强耦合，迁移版本互相牵制，且拆不出去。
3. **宠物做成插件（QuickJS 沙箱）**：20 Hz 跨语言调用 + 渲染描述成本高；插件权限模型（网络/凭据）与宠物（画画）不同，混在一起会让白名单失去意义。
4. **宠物单独一个 Tauri 窗口**：桌面上可行，但 Android 没有第二窗口；将来要「盖在别的应用上」应走系统悬浮窗，而不是宠物架构。

## 后果

- 正面：行为可单测；两个引擎可各自演进/各自发布；UI 可替换；数据可独立备份/迁移；
  为「宠物独立成仓库」留好了零成本切口（没有仓内相对依赖、没有共享类型）。
- 代价：多一个 crate、多一份 SQLite 文件与一个迁移序列；宿主多做一层转换（`Track → PlaybackHint`）；
  `pnpm verify` 多两道关卡（独立性守卫 + 宠物单测）。
- 风险：宠物包是**用户提供的不可信数据**（大图/异常帧数/超长文案键）→ 已按上限校验；
  一旦允许脚本，安全模型会整体改变 → 明确留到新 ADR。

## 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| **M0** | `pet-core` crate：规格校验、确定性状态机、独立 `pet.db`、跨会话资料（好感/饥饿/衰减/冷却）、10 项单测、独立性守卫纳入 `verify` | ✅ 已落地（R88） |
| **M1** | 宿主桥：`pet-core::dispatch`（6 条命令，**可单测**）+ `src-tauri` 的独立入口 `pet_invoke`（同一信封形状、宠物自己的错误码）+ `src.services/core.pet.ts` 门面 + `src/pet` 内置宠物（程序化渲染）+ 设置页「实验」开关（默认关）；`check:reachability` 扩到 `pet.*` | ✅ 已落地（R90） |
| M2 | 宠物包导入：`pet.install{spec, atlas?}`（图集 png/webp、纯文件名、≤ 8 MiB，落 `<data>/pet/packages/<id>/`）+ `pet.atlas{id}`（base64 回传）+ 设置页管理面板（列表/切换/移除/导入）+ 渲染器按图集帧条作画；`pet.state` / `pet.remove` 接上界面 | ✅ 已落地（R91） |
| M3 | 交互与玩法：`hungry` / `bondAtLeast{tier}` 两个行为条件（阈值只在 `PetProfileLimits`，宠物包只写「做什么」）、心情分档（派生值，不落库）、喂食/触摸 UI 与「饿了」徽标、`pet.state` 读前结算时间流逝 | ✅ 已落地（R92） |
| M3.5 | 真实素材：网格图集（`atlasLayout` + `Animation.row`，一行一个动画）、内置宠物换成 9 行 sprite sheet（`pets/gently-mascot/`，与用户导入的包同一套格式）、渲染器统一走 `frame-layout` 纯函数、单行帧条保留兼容 | ✅ 已落地（R93） |
| **M3.6** | 宠物**独立成窗口**（`pet`：无边框、透明、置顶、不进任务栏），主窗口最小化它照样在桌面上；播放快照走窗口间事件（ready 握手 + 2s 心跳）；关主窗口 = 退出应用 | ✅ 已落地（R94） |
| **M5** | **兼容 Codex Pet v1 包**：`pet.install` 同时收社区格式（`{id, displayName, spritesheetPath}`），核心补齐 8×9 网格 / 9 个动作 / 默认行为表；v2 明确拒绝；渲染端对「没有 alpha 的白底图集」自动去底 | ✅ 已落地（R96） |
| **M6** | **看向光标**：`pet.tick` 增加 `lookDir`（0..15，0 = 正上、顺时针），核心规范化并原样回传 `frame.look`；规格增加 `lookRows`（两行 × 8 格 = 16 方向）；Codex v2（8×11）开始受支持；宿主在 Windows 上轮询全局光标并发 `gently:pet:look`；渲染层只在待机时用 look 格 | ✅ 已落地（R99） |
| **M7** | **宠物 Beta 1.0.0**：`pet-core` 升到 1.0.0（自己的版本号，不跟音乐软件走）、内置宠物包 1.0.0、渲染器 1.0.0；设置页从「实验（预开发）」升为「宠物（Beta）」；补右键喂食 + 提示气泡、自动点击穿透、用户指南 [`docs/pet.md`](../pet.md)。**1.0 = 桌面宠物的功能面收敛**，剩下的（走动、逐像素命中、v2 素材画面验证）明确留到 1.x/2.x | ✅ 已落地（R101） |
| M4 | 移动端渲染器（WebView canvas 或系统悬浮窗，见安卓评估 §3.7）与宠物独立化评估 | 未排期 |

### M7：1.0 的边界（什么是「完成」，什么是「以后」）

| 属于 Beta 1.0（已做） | 留给以后 |
|---|---|
| 独立引擎 + 独立库 + 独立窗口；主窗口最小化仍在 | 移动端渲染器（M4） |
| 动画（网格 / 帧条 / look 两行）、整数倍缩放、白底去底 | 逐像素 alpha 命中（现在用外接矩形） |
| 好感/饥饿/心情/喂食冷却，跨会话持久化与退出写回 | 宠物在屏幕上走动（`runLeft`/`runRight` 需要位置行为） |
| 导入：我们的格式 + Codex v1/v2；校验和 | v2 素材的画面级验证（仓库里只有 v1 素材） |
| 看向光标、自动点击穿透、锁定、位置记忆与夹回 | 多宠物 UI（存储/API 已预留） |
| 设置页管理（开关/预览/喂食/切换/移除/导入/锁定） | 宠物包文案词表（现在只能复用宿主键） |

### M6：为什么 look 由宿主轮询、核心只透传（R99）

「宠物看着你的鼠标」需要**全局**光标位置，而宠物窗口只在自己那 200×160 里收得到指针事件。
所以分工是：

1. **宿主**（`src-tauri/src/pet_watch.rs`）每 60ms 读一次 `GetCursorPos`，算相对宠物窗口中心的角度，
   量化成 16 个方向，**变了才** `emit_to("pet", "gently:pet:look", dir)`；
2. **渲染层**把最新的 `lookDir` 放进 `pet.tick` 的输入；
3. **核心**不读时钟、不读光标：只把 `lookDir` 规范到 0..15 并原样回传 `frame.look`
   （这样状态机仍然可复现，测试给固定的 `look_dir` 就能断言）；
4. **挑哪一格**由渲染层按 `lookRows` 决定，且**只在待机时**用 look 格——奔跑/跳跃是行为驱动的动作，
   这时换成一张静止的 look 帧看起来像卡住。

取舍：非 Windows 平台没有 `GetCursorPos`（不引平台 crate），宠物就只播动画、不发 look 事件；
`look_dir` 在核心是可选输入，缺失时行为完全等同以前。

### M3.6：宠物为什么必须独立成窗口（R94）

这是对「宠物是主窗口里的一块浮层」的**纠正**，不是优化：

| 留在主窗口里（旧） | 独立窗口（现在） |
|---|---|
| 主窗口最小化 / 被别的应用盖住 → 宠物一起消失 | 宠物是桌面上的置顶小窗，音乐软件最小化也还在 |
| 与音乐软件的界面抢同一块像素（盖住设置页按钮） | 位置由自己决定（默认主屏右下角），不占应用界面 |
| 「宠物」与「播放器 UI」在同一个 WebView 里互相影响 | 两个 WebView：宠物崩了不影响播放器，反之亦然 |
| 只能靠主窗口的存在而存在 | 关主窗口 = 退出应用（两个窗口一起收），语义明确 |

代价与取舍：

1. **数据要跨窗口传**：宠物窗口没有 store。主窗口推一份**只读播放快照**（`playing / 歌词行 / 曲目 id` + 宠物 revision），
   与桌面歌词同一条路子（窗口间事件，不是新契约）。事件不排队，所以有 `ready` 握手 + 2s 心跳兜底。
2. **`capabilities` 要登记新窗口**：Tauri 2 的 ACL 按窗口授权，漏登记的表现是「窗口开着但一片空白」，
   没有任何报错（GOTCHAS §30）。
3. **点击穿透没做**：窗口是 200×200 的矩形，透明区域仍然吃鼠标。窗口已经贴着宠物、位置固定，先把功能做出来；
   按像素 hit-test 留到 M4。
4. **关窗口 = 关宠物**：宠物窗口没有标题栏/按钮，隐藏它只有两条路——设置页关开关，或退出应用。
   拖动靠顶部 14px 的透明条（宠物本体留给「点一下 = 触摸」）。

### M3.5 的几处实现取舍

1. **两种图集共存，不强制迁移**：老包是「单行帧条，总帧数等分整图」，新包可以写
   `atlasLayout{frameWidth, frameHeight, columns, rows}` 直接交 sprite sheet。不写 `atlasLayout`
   就仍按帧条解释——已发布的包不会因为这次改动变成「画半个头」。
2. **隐含行号 + 显式覆写**：第 N 个动画默认取第 N 行，需要重排就写 `row`。
   写错（行越界、帧数超过列数、有网格没图、有 `row` 没网格）一律报错——这些都是静默画错的来源。
3. **布局算法抽成纯函数**（`src/pet/frame-layout.ts`）：`[动画][帧] → {x,y}` 一次算完，
   DOM 只读结果。行/列/帧数是同一张图的三种坐标，算错只能靠肉眼发现，所以要有纯函数单测。
4. **内置宠物 = 仓库里的宠物包**：`src/pet/builtin.ts` 直接 import `pets/gently-mascot/pet.json`
   与 `atlas.png`，安装时把图集一起交给核心。这样「内置」与「导入」不是两套格式，
   也不会出现示例包与内置包各自漂移。
5. **图集必须带透明通道**：用户给的素材常是白底 webp；直接当图集用会渲染出一个方块。
   `pets/gently-mascot/atlas.png` 是去掉白底后的透明版，规范里也把这条写成硬要求。

### M5：为什么兼容 Codex Pet v1（R96）

社区 [Awesome Codex Pet](https://codexpet.top) 已经有几百只宠物，格式是 `pet.json` + `spritesheet.webp`，
**图集几何与我们完全一样**（8×9、每格 192×208、空格透明）。差异只在「谁不写什么」：

| | Codex Pet v1 | 我们 |
|---|---|---|
| 动作表 | 不写（运行时约定：9 行、固定帧数） | `animations`（名字/帧数/时长/行号） |
| 行为 | 不写（运行时内置一套） | `behaviors`（条件 → 动作，可自定义） |
| 图集命名 | `spritesheetPath` | `atlas` + `atlasLayout` |
| 版本 | `spriteVersionNumber`（1 / 2） | 语义化 `version` |

取舍：

1. **收进来，但不建市场**（ADR 0003 / 0005）：判定靠 `spritesheetPath` 字段，翻译在核心里
   （`pet-core/src/codex.rs`），宿主依旧只是「把 JSON 原文交进来」。没有浏览/推荐/预置入口，
   用户必须自己提供文件——这与插件/皮肤一致。
2. **只支持 v1**：v2 是 8×11、多两行 16 个 look 方向，而我们的 `Input` 里没有「看向哪里」，
   假装能画只会画错；错误信息里写明缺什么能力。
3. **动作名/帧数按社区约定补齐**，不是猜的：帧数来自图集实际占用（空格子必须全透明），
   与我们在 `pets/gently-mascot` 上量到的 6/8/8/4/5/8/6/6/6 一致；帧时长是我们定的（社区包不写）。
4. **白底图集自动去底**：社区里确实存在「导出时被压平」的图集（用户给我的那份就是白底 webp）。
   渲染端在画之前检测「有没有透明像素」，没有就用角落底色抠掉（容差 18/通道）；
   这既是兼容性兜底，也省得用户自己开图像软件。
5. **许可要小心**：那个仓库的素材是 CC BY-NC 4.0（非商业），代码 MIT。用户自用导入没问题，
   但**不能**把别人的宠物打包进交付物——所以这里只做「格式兼容」，不做「素材分发」。

### M3 的几处实现取舍

1. **心情是派生值**：`PetProfile::mood(limits)` 从好感算出（shy/friendly/close/devoted），
   **不落库**——否则库里会同时存在「好感」与「心情」两个真相，改数值时必然打架。
2. **`pet.state` 读前结算**：面板显示的是「现在」的饿/好感，而不是上次退出时的值；
   否则「关掉一夜再打开，它明明饿坏了却显示不饿」。
3. **阈值集中在 `PetProfileLimits`**：宠物包只声明「饿的时候演什么、说什么」，不写数值；
   调平衡改一处，所有宠物同时生效。
4. **「没有匹配就保持当前动画」**：不替作者猜「该回到待机」——想回去就写一条 `idle → play(idle)`，
   这条已写进契约 §2（行为表语义），并有一个测试专门锁它。
5. **内置宠物随应用升级**：渲染器发现库里的内置宠物版本落后于随包版本时自动重装
   （M3 给内置小家伙加了「饿」的动画，不升级的话老用户永远看不到）；用户导入的包不动。

### M2 的几处实现取舍（后续里程碑要看）

1. **图集走 base64 回传，不开口环代理**：`pet.atlas` 回 `{file, dataBase64}`。理由：宠物引擎
   **不能依赖**音乐核心的媒体代理（ADR 0010 的边界），而一张图 ≤ 8 MiB，直传比再开一条代理链路简单；
   解码用 20 行的自带 base64（不引入依赖）。
2. **图集约定**：横向帧条，**总帧数 = 各动画帧数之和**，按 `animations` 顺序排列；
   没有图集的包走**程序化渲染**（M1/M2 的内置小家伙就是这种；M3.5 起内置宠物换成了网格图集）。
3. **素材目录整包走**：`<data>/pet/packages/<id>/<文件名>`，库里只记**纯文件名**——
   数据目录整体搬家后仍然有效（与皮肤背景同一条规则）；卸载时连目录一起删。
4. **切换/安装/卸载要重挂渲染器**：渲染器在 `mount` 时读一次「当前出战是谁」，
   因此 store 里有一个 `petRevision` 计数器，设置页每次改动后 +1，App 用它重新注册
   （比在每个组件里塞幂等逻辑更容易说清「什么时候需要重挂」）。

### M1 的几处实现取舍（后续里程碑要看）

1. **分发在核心、宿主只有薄壳**：命令路由是 `pet_core::dispatch(engine, command, params, now_ms)`，
   因此不需要起 Tauri 就能单测（`pet-core/tests/dispatch.rs` 7 项）；`src-tauri` 只做
   「取时间 → 调 dispatch → 包信封」。
2. **时间由宿主给**：`dispatch` 收 `now_ms`，核心不读时钟（可复现）；写入靠「每 200 帧写回 + 交互立即写」，
   退出时宿主在 `RunEvent::Exit` 里调一次 `engine.flush()`（M3 补上），因此游走状态最多丢进程被强杀的极端情况。
3. **内置宠物是程序化渲染，不是素材包**：M2 才定 `pet.json` + 图集；先把「出帧 → 画 → 点击回喂」链路跑通，
   避免素材格式先定死再为它反复改。
4. **默认关、显式 opt-in**：宠物是 2.x 形态，1.x 里只有设置页「实验（预开发）」一个开关；
   关掉时 `PetHost` 渲染 null、不注册任何宠物（零成本）。

## 未决问题


1. **宠物包分发**：只靠用户主动导入文件（与插件/皮肤一致），不建市场（ADR-0005）。
2. **多宠物**：UI 何时放开？建议先只在核心与存储上支持，等独立化时再定交互。
3. **文案键边界**：宠物包不提供文案，宿主 i18n 只保证有限键；超出时显示什么（建议回落到无气泡）。
4. **素材类型**：只允许 png/webp；webm 循环视频成本高、耗电，暂不做。
5. **移动端渲染器**：与安卓评估里的 P1/P4 一起定（M4，当前被安卓延后阻塞）。

## 独立化评估（「以后可能拆成独立仓库/应用」离现在多远）

| 维度 | 现状 | 拆出去要做什么 |
|---|---|---|
| 代码依赖 | `pet-core` **零仓内依赖**（独立性守卫每次 verify 都查），无 `tauri`/`gently-core` | 复制目录 + 新 workspace 即可 |
| 命令入口 | 契约名与信封形状已独立；`pet_invoke` 是**宿主**的一行适配 | 新宿主实现同形的一个入口即可 |
| 数据 | 自己的 `pet.db` + `packages/`，目录由宿主传入 | 独立应用自己决定目录（当前是 `<data>/pet`） |
| 语义依赖 | 发布快照是 `PlaybackHint`（playing/elapsed/歌词有无/曲目哈希），**不是**音乐软件的 `Track` | 独立应用若没有播放器，就不喂这些字段（全 false 也能跑） |
| UI | 渲染器在音乐软件前端（`src/pet/core-pet.ts`），文案键在音乐软件的 i18n 里 | 拆出时要自带一份渲染器与文案；`pet-core` 不用改 |
| 守卫 | 独立性 + 契约表 + 分发单测 | 把 `check-pet-independence` 与 `tests/contract.rs` 一起搬走 |

结论：**核心层已经独立**，真正与音乐软件耦合的只有「宿主入口 + 渲染器 + 文案」这三样，
而且都在边缘。M4 的「独立化评估」因此可以降级为「哪天要做时按上表搬一遍」，
不需要再设计一遍架构。

## 相关文档

- 宠物扩展点的既有边界与版本线：ADR [`0007-versioning-and-pet-extension.md`](0007-versioning-and-pet-extension.md)
- 中立第三方 / 插件兼容模式：ADR [`0005`](0005-neutral-third-party.md) / [`0006`](0006-plugin-format-dual-track.md)
- 可沿用与桌面专属清单：[`../DESIGN-REUSE.md`](../DESIGN-REUSE.md)
- 宠物包怎么写（`pet.json` + 图集 + 行为表）：[`../pet-package.md`](../pet-package.md)
- 安卓端（渲染器选择、后台限制）：[`../ANDROID-INFRA-ASSESSMENT.md`](../ANDROID-INFRA-ASSESSMENT.md)
- 代码：`pet-core/src/{lib,spec,sim,store,engine,profile,error}.rs`、`pet-core/tests/core.rs`
