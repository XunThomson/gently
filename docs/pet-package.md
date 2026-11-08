---
status: active
last_verified: 2026-10-31
owner: gently
scope: 宠物包（pet.json + 图集）的制作规范与校验规则
token_budget: 900
tldr: 宠物包是**数据包**：一个 `pet.json` 加一张可选的图集（png/webp）。图集两种排法——**网格 sprite sheet**（`atlasLayout`，一行一个动画，推荐）或单行帧条（老格式）。没有脚本、没有网络、没有文件系统访问。行为由 `behaviors` 表声明（条件 → 动作），顺序即优先级；没有匹配就保持当前动画。仓库里就有一个真包：`pets/gently-mascot/`（内置宠物）。导入入口：设置 → 宠物（Beta）→ 导入宠物包。
---

# 宠物包规范（pet.json + 图集）

> 面向**宠物包作者**。实现与契约见 [`contracts/pet-core-api.md`](contracts/pet-core-api.md)，
> 引擎边界见 [`adr/0010-pet-core-crate.md`](adr/0010-pet-core-crate.md)。
> 宠物现在是 **Beta 1.0**：入口在设置页的「宠物（Beta）」里，默认关闭（使用说明见 [`pet.md`](pet.md)）。
> 宠物跑在**自己的置顶小窗**里（不在音乐软件窗口内），所以它不会跟着主窗口一起被最小化。
> **照抄起点**：[`pets/gently-mascot/`](../pets/gently-mascot/) 就是一个完整可用的包
> （9 行动画的网格图集），内置宠物用的就是它——不存在「示例一套、真用另一套」。

## 1. 包长什么样

```
my-pet/
  pet.json      # 必需：规格（下面 §2）
  atlas.png     # 可选：图集（png / webp）
```

- **没有脚本**：宠物包不含 JS / HTML / 任何可执行内容。宠物只会「播动画 / 说一句 / 转向」，
  它拿不到网络、文件与凭据（与插件的安全模型完全不同，`adr/0007`）。
- **图集可选**：没有图集时用「程序化渲染」（一个会呼吸的圆），适合先做行为原型。

## 2. `pet.json`

最小可用（单行帧条，8 帧横着一排）：

```json
{
  "id": "my-pet",
  "name": "我的宠物",
  "version": "1.0.0",
  "author": "you",
  "atlas": "atlas.png",
  "animations": [
    {"name": "idle",   "frames": 4, "frameMs": 320, "loop": true},
    {"name": "happy",  "frames": 2, "frameMs": 160, "loop": true},
    {"name": "hungry", "frames": 2, "frameMs": 420, "loop": true}
  ],
  "behaviors": [
    {"when": {"kind": "hungry"},  "then": {"kind": "play", "animation": "hungry"}, "cooldownMs": 1200},
    {"when": {"kind": "hungry"},  "then": {"kind": "say",  "textKey": "pet.bubble.hungry"}, "cooldownMs": 60000},
    {"when": {"kind": "clicked"}, "then": {"kind": "play", "animation": "happy"},  "cooldownMs": 400},
    {"when": {"kind": "playing"}, "then": {"kind": "play", "animation": "happy"},  "cooldownMs": 6000},
    {"when": {"kind": "idle"},    "then": {"kind": "play", "animation": "idle"},   "cooldownMs": 1200}
  ],
  "minPetCoreVersion": "0.1.0"
}
```

网格版（**推荐**：直接把 sprite sheet 交进来，不用先拼长图）：

```json
{
  "id": "my-pet",
  "name": "我的宠物",
  "version": "1.0.0",
  "atlas": "atlas.png",
  "atlasLayout": {"frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 9},
  "animations": [
    {"name": "idle",   "frames": 6, "frameMs": 240, "loop": true, "row": 0},
    {"name": "listen", "frames": 6, "frameMs": 200, "loop": true, "row": 7},
    {"name": "sad",    "frames": 6, "frameMs": 260, "loop": true, "row": 6}
  ],
  "behaviors": [
    {"when": {"kind": "hungry"},  "then": {"kind": "play", "animation": "sad"},    "cooldownMs": 1200},
    {"when": {"kind": "playing"}, "then": {"kind": "play", "animation": "listen"}, "cooldownMs": 6000},
    {"when": {"kind": "idle"},    "then": {"kind": "play", "animation": "idle"},   "cooldownMs": 1200}
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 小写字母 / 数字 / `.` `-` `_`，2–64 位，**不能含路径分隔符**；同名覆盖安装（会**保留**好感与饱食度） |
| `name` | ✅ | 展示名 |
| `version` | ✅ | 语义化版本（`x.y.z`；`1.0`、`v1.2.3`、`1.2.3-rc1` 都收）；内置宠物按它决定是否自动升级 |
| `author` / `minPetCoreVersion` | — | `author` 只做展示；`minPetCoreVersion` **真的会被比较**（R106）：高于本机核心 → 安装时报 `pet.incompatible`，留空 = 没要求 |
| `atlas` | — | 图集文件名，**只能是纯文件名**（不允许 `/` `\` `..`）；写 `atlasLayout` 时必填 |
| `atlasLayout` | — | 网格图集的格子与行列：`{frameWidth, frameHeight, columns, rows}`；不写就按**单行帧条**解释 |
| `animations` | ✅ | 至少 1 个，最多 32 个；每个 `frames` 1–512、`frameMs` > 0；有 `atlasLayout` 时 `frames ≤ columns` |
| `animations[].row` | — | 网格里的行号（0 起）；不写按**声明顺序**取行；只能配 `atlasLayout` 用 |
| `animations[].fit` | — | 该行的显示适配 `{scale, offsetX, offsetY}`：整行等比缩放 + 原图像素微调，用来对齐各行角色的视觉大小（见 §3.1） |
| `behaviors` | — | 最多 128 条（32×4） |

## 3. 图集约定

**排法一：网格 sprite sheet（`atlasLayout`，推荐）**

- 图是规整的格子阵：每格 `frameWidth × frameHeight`，**一行一个动画**；
- 第 N 个动画默认取第 N 行（也可以显式写 `row`）；一个动画从该行的**第 1 格**向右取 `frames` 格；
- 行里的空格子留着不用即可（右上角没有东西不影响）；
- 例：`pets/gently-mascot/atlas.png` 是 1536×1872，`{frameWidth:192, frameHeight:208, columns:8, rows:9}`
  → 9 行、每行最多 8 帧（第 1 行只用了 6 格）。

### 3.1 各行角色大小不一样怎么办（`fit`）

真实素材常是分几批画的（或 AI 生成的），**同一张图集里各行角色的比例能差 20%**，
于是「待机 → 跑」时宠物会突然变大。给那一行写 `fit` 就能对齐：

```json
{"name": "runLeft", "frames": 8, "frameMs": 140, "row": 1, "fit": {"scale": 0.8}},
{"name": "run",     "frames": 6, "frameMs": 130, "row": 7, "fit": {"scale": 1.08, "offsetY": 0}}
```

| 字段 | 含义 |
|---|---|
| `fit.scale` | 相对整格的倍数（0.25–2.0，默认 1）。渲染层把**整行**等比缩放（最近像素，不做平滑） |
| `fit.offsetX` / `fit.offsetY` | 原图像素为单位的微调（不超过一格），用来把角色推回视觉中心 |

规则与限制：

- **整行一个倍率**：不按帧单独缩放（否则每帧的包围盒抖动会让角色一胀一缩）；
- 每行按「**水平居中 + 底部对齐**」放进盒子，盒子取所有行里最大的那一格——所以 `scale > 1` 也不会被裁切；
- `lookRows` 那两行**不受 `fit` 影响**：它们是同一张脸的 16 个方向，缩放会让「看鼠标」时脸忽大忽小；
- 没写 `fit` 的包行为与以前完全一样（盒子 = 一格，96×104）。

怎么量自己的素材（可选）：把每一行的**角色像素包围盒**（透明通道 > 约 10%）求出来，
以**待机行的高度**为基准，`scale = 待机高度 / 这一行的高度`；头部特写行按**头宽**对齐会更准。
内置宠物就是这么定的（`pets/gently-mascot/pet.json`，实测 0.8–1.08）。

**排法二：单行帧条（不写 `atlasLayout`，老格式）**

- 所有帧从左到右排成一行；
- **总帧数 = 各动画 `frames` 之和**，按 `animations` 的**声明顺序**排列
  （上面的最小例：idle 4 帧 + happy 2 帧 + hungry 2 帧 = 8 帧）。

**两种排法共同的硬要求**

- **图集必须带透明通道**：白底/黑底的 png 会连背景一起渲染成一个方块。
  拿到「白底的 sprite sheet」时，先把底色去掉再当图集（透明 png 或带 alpha 的 webp）；
- 桌宠显示高度有 **104 / 208 / 312px** 三档（小 / 标准 / 大，默认标准），设置页预览仍用 104px；
  宽度按格子（或帧条）比例缩放——所以**同一张图里所有格子的尺寸要一致**；
- 只收 **png / webp**，单文件 ≤ 8 MiB。

## 4. 行为表：能写什么

**条件（`when`）**

| kind | 含义 |
|---|---|
| `idle` | 没在播放、指针也不在（默认待机） |
| `playing` | 音乐正在播放 |
| `silentFor{ms}` | 没在播放（当前只看「没在播放」，`ms` 必须 > 0 才会成立；`0` 等于永不触发） |
| `lyricActive` | 当前有歌词行 |
| `pointerNear` | 指针靠近宠物 |
| `clicked` | 这一帧被点了 |
| `trackChanged` | 换歌 |
| `hungry` | 饿了（阈值由核心的 `PetProfileLimits` 决定，作者不用管数值） |
| `bondAtLeast{tier}` | 好感达到某一档（`shy` / `friendly` / `close` / `devoted`） |
| `walking{dir}` | 宿主正在把窗口往左（-1）/ 往右（1）挪；宠物包只声明「走的时候演什么」 |

**动作（`then`）**

| kind | 参数 | 含义 |
|---|---|---|
| `play` | `animation` | 切到某个动画（必须是 `animations` 里声明过的名字） |
| `say` | `textKey` | 显示气泡（只给**文案键**，文案由宿主 i18n 提供；未知键会原样显示键名） |
| `face` | `dir`（-1 / 1） | 水平翻转 |
| `anchor` | — | 回到锚点 |

**两条必须知道的语义**

1. **顺序即优先级**：每帧取**第一条**「条件成立且冷却已过」的行为。饿的表现要写在待机前面。
2. **没有匹配就保持当前动画**：想让宠物回到待机，显式写 `idle → play(idle)`；
   核心不会替你猜「该回哪儿」。

### 4.1 动画衔接：`interrupt`

同一条 `play` 行为默认**不是**「立刻切」：核心要让同一个目标连续被请求满 **160ms** 才真的换动画。
这一条是为了修「走动时动画闪一下」——宿主每 60ms 报一次走动方向，光标擦过宠物会让某一拍报回 0，
没有确认期就会「跑 → 待机 → 跑」。

用户主动的动作（点一下、换歌）希望**立刻**有反馈，就在 `then` 里加 `"interrupt": true`：

```json
{"when": {"kind": "clicked"}, "then": {"kind": "play", "animation": "jump", "interrupt": true}, "cooldownMs": 400}
```

- 只对 `play` 生效；`say` / `face` / `anchor` 一直是立即执行；
- 带 `interrupt` 的行为同样受 `cooldownMs` 约束（冷却内不会反复打断）。

### 4.2 「静默超过 N 毫秒」是真的按时间算（R106）

`{"kind": "silentFor", "ms": 3000}` 现在的语义是：**连续 3 秒没在放音乐**才成立；
播放一恢复，计时立刻归零。`ms = 0` 等价于「一停播就算」。

（R106 之前它是「没在播就算」，`ms` 是个摆设——写 3 秒的「安静一会儿再打哈欠」会在停播那一拍就开始打。）

### 4.3 打断型动画要演完一遍（R106）

带 `"interrupt": true` 的动作（点击 / 换歌）当拍切换，并且**至少演完一遍**
（`frames × frameMs`，夹在 200–2000ms）才允许状态机接管。
否则「当前状态是待机」会在 160ms 后把反应动作掐掉，看着像「点了一下它抖了一下」。
## 5. 校验与错误

导入时核心会逐项校验，失败给**可读原因**（不会只回一句「非法」）：

| 情况 | 错误码 |
|---|---|
| 不是合法 JSON / 缺必填字段 / id 非法 / 动画名重复 / 引用了不存在的动画 | `pet.invalid_package` |
| 网格写错：`frames` 超过列数、`row` 超出图集、有 `atlasLayout` 却没有 `atlas`、写了 `row` 却没有 `atlasLayout`、格子尺寸为 0 | `pet.invalid_package`（消息里带具体是哪条动画） |
| 帧数、动画数、包体超上限；图集体积超限；`atlasLayout` 的 `columns`/`rows` 超过 64 | `pet.limit_exceeded` |
| 图集文件名带路径、类型不是 png/webp、文件是空的 | `pet.invalid_package` |
| 气泡 `textKey` 为空或超 64 字符、`face.dir` 不是 -1/1 | `pet.invalid_argument` |
| 读不出图集（文件丢了） | 视为「没有图集」，不报错 |

## 6. 安装与升级

- 入口：**设置 → 宠物（Beta）→ 导入宠物包**：
  - 把 `pet.json` **拖进投放区**（或直接粘贴 JSON），把图集拖进来（或点「选择图集」）；
  - 拖进来的 `.json` 会填进文本框、`.png/.webp` 会当图集，其它类型忽略；
- 设置页会在每个已安装宠物左边**实时画一段待机动画缩略图**（取的就是图集本身，不额外存缩略图）；
- 素材落在数据目录下的 `pet/packages/<id>/`，库里只记文件名——
  整个数据目录搬家后仍然有效；
- 同 id 覆盖安装 = 升级：**保留**好感度与饱食度；
- 内置宠物（`gently-mascot`）会随应用升级自动更新，作者自己的包不受影响。

## 6.1 内置宠物用的 9 个动作（第 N 行 = 第 N 个动作）

`pets/gently-mascot/atlas.png` 是 9 行 × 8 格（每格 192×208），**行的顺序就是素材作者给的顺序**：

| 行 | 动作（`animations[].name`） | 帧数 | 行为表里什么时候播 |
|---|---|---|---|
| 0 | `idle` 待机 | 6 | 没有别的事（待机） |
| 1 | `runLeft` 向左跑 | 8 | 目前没接条件（留给「走到左边」类行为；与第 2 行是镜像） |
| 2 | `runRight` 向右跑 | 8 | 同上 |
| 3 | `wave` 挥手 | 4 | 指针靠近宠物 |
| 4 | `jump` 跳跃 | 5 | 点一下宠物 |
| 5 | `fail` 失败 | 8 | 饿了 |
| 6 | `wait` 等待 | 6 | 目前没接条件（`wait` 与待机很近，容易重复） |
| 7 | `run` 奔跑 | 6 | 正在播放音乐 |
| 8 | `inspect` 审察 | 6 | 换歌（看看换成了什么） |

行为表在 `pets/gently-mascot/pet.json`：改「什么时候演哪个动作」只改那个文件，不用碰代码。

**像素画的两条硬要求**（内置包就是这么做的，别用别的比例）：

1. **图集必须带透明通道**（白底直接当图集 = 渲染出白方块）；
2. **优先整数比例并关闭插值**：桌宠高度为 104 / 208 / 312px，设置页预览为 104px（格子高 208）。
   像素画按 96/208 这种比例平滑缩放时，深色描边旁边会出现**黑色颗粒/毛边**；渲染器统一使用
   `image-rendering: pixelated`，并对背景尺寸与偏移取整，三档切换只重算布局，不重新解码图集。

## 7. 现在还做不到的（如实标注）

- ~~版本比较~~ 已做（R106）：`version` / `minPetCoreVersion` 都按语义化版本校验并比较；
- **逐帧不均匀的图集**：同一张图里所有格子必须一样大（不支持每格自带偏移的 `atlas.json`）；
- 宠物**在屏幕上走动**（`moveTo` 之类）：宠物已经是独立小窗，但位置只由「右下角 + 用户拖动」决定；
- 气泡文案的自定义词表（只能用宿主已提供的键）。

## 8. 兼容 Codex Pet v1 包（社区格式）

社区项目 [Awesome Codex Pet](https://codexpet.top)（`github.com/legeling/awesome-codex-pet`）已经积累了
几百只宠物，包结构是 **`pet.json` + `spritesheet.webp`**，图集几何与我们的网格图集**完全一样**
（8 列 × 9 行、每格 192×208、未使用的格子全透明）。所以这里直接支持导入它们：

```json
{
  "id": "aemeath-mini--cunuo",
  "displayName": "Aemeath Mini",
  "description": "…",
  "spritesheetPath": "spritesheet.webp",
  "kind": "character"
}
```

判定很简单：JSON 里有 `spritesheetPath` → 按 Codex 包处理（我们自己的格式没有这个字段）。
导入时核心里补齐作者没写的那部分（这些在 Codex 那边是运行时约定，包里不写）：

| 行 | 动作 | 帧数 | 帧时长 |
|---|---|---|---|
| 0 | `idle` | 6 | 240ms |
| 1 | `runLeft` | 8 | 140ms |
| 2 | `runRight` | 8 | 140ms |
| 3 | `wave` | 4 | 170ms |
| 4 | `jump` | 5 | 150ms |
| 5 | `fail` | 8 | 220ms |
| 6 | `wait` | 6 | 240ms |
| 7 | `run` | 6 | 130ms |
| 8 | `inspect` | 6 | 200ms |

行为表用一套通用默认（饿了→失败、点一下→跳跃、换歌→审察、播放中→奔跑、指针靠近→挥手、待机→待机）。

**v2（8×11，16 个 look 方向）也支持**（R99 起）：`spriteVersionNumber: 2` 的包会被翻译成
「9 行动画 + 后两行 look」——`lookRows: [9, 10]`，16 个方向按「先横着排满一行 8 格、再排第二行」，
0 = 正上、顺时针。宿主会轮询全局光标（目前只有 Windows），方向变了就通过
`gently:pet:look` 事件告诉宠物窗口；渲染层**只在待机时**用 look 格（奔跑/跳跃时换格子会像卡住）。
自己写包时也可以手写 `"lookRows": [9, 10]` 上这一能力（要求图集一行 ≥ 8 格、两行不与动画行重叠）。

**边界（有意的）**：

- v3 及以上：明确报错（我们只认 v1 / v2 的几何）；
- look 的轮询**只在 Windows 上实现**（`GetCursorPos`）；其它平台宠物就只播动画，不会报错也不会假装；
- **不内置、不推荐、不预置任何第三方宠物**（ADR 0005）：只能由用户自己把 `pet.json` + 图集交进来，
  界面上没有「浏览市场」这种入口；
- **不联网、不代下载**：他们那边的 npm 安装器会做 SHA-256 校验与分步落盘，那是它们安装器的职责；
- **许可**：那个仓库的素材是 **CC BY-NC 4.0**（非商业），代码 MIT。用户自己导入自用没问题，
  但如果要在产品里内置/分发别人的宠物，必须先看对方仓库里每个包的 `submission.json` 与许可。










