---
status: active
last_verified: 2026-11-01
owner: gently
scope: 宠物核心（pet-core）的对外契约：命令命名空间、错误码、信封形状
token_budget: 600
tldr: pet-core **Beta 1.0.0**：独立引擎（ADR 0010），因此有独立的命令命名空间 `pet.*` 与独立错误码 `pet.*`；信封形状与音乐核心一致（`{ok, data|error, traceId}`）。本文件与音乐核心契约并列，**不是**它的章节。
---

# pet-core 契约（Beta 1.0.0）

> 版本：`pet-core 1.0.0`（`PET_CORE_VERSION`，与 `pet-core/Cargo.toml` 一致）。
> 1.0 起的能力面：7 条命令 / 7 个错误码 / 网格与帧条两种图集 / look 两行（Codex v2）/ 图集校验和 / 包版本兼容检查。

> 与音乐核心契约的关系：**并列，不包含**。`gently-core` 的契约在
> [`local-core-api.md`](local-core-api.md)；两个引擎互不依赖，各自被宿主消费（ADR 0010）。
> 唯一共享的是**信封形状**（下面 §1）——那是约定，不是代码依赖。

## 1. 信封与错误码

宿主把宠物域的返回统一包成：

```json
{ "ok": true,  "data": { ... }, "traceId": "..." }
{ "ok": false, "error": { "code": "pet.invalid_argument", "message": "…", "details": { … } }, "traceId": "…" }
```

错误码（跨语言 ABI，与 `pet-core/src/error.rs` 的 `as_str()` 一一对应）：

| code | 含义 | 典型场景 |
|---|---|---|
| `pet.invalid_argument` | 参数非法 | 喂食还在冷却、Face 的 dir 不是 ±1 |
| `pet.not_found` | 找不到这个宠物 | 指定了没安装的宠物 id |
| `pet.invalid_package` | 宠物包非法 | `pet.json` 结构不对、引用了不存在的动画、`version` 不是语义化版本 |
| `pet.incompatible` | 宠物包与当前核心不兼容 | 包的 `minPetCoreVersion` 高于本机核心（R106 起真的比较） |
| `pet.limit_exceeded` | 超出限制 | 帧数 / 动画数 / 包体超过上限 |
| `pet.io_error` | 本地读写失败 | 宠物库打不开、写入失败 |
| `pet.internal` | 内部错误 | 运行时丢失（理论上不该发生） |

## 2. 命令清单

宿主用**独立命令入口** `pet_invoke{command, params}`（与音乐核心的 `core_invoke` 并列，
不是它的分支），核心入口是 `pet_core::dispatch(engine, command, params, now_ms)`。
时间由宿主给（系统时钟），测试给固定值——因此同一份输入序列可复现。

| 命令 | 参数 | 返回 |
|---|---|---|
| `pet.state` | — | `{active, pets:[{id,name,version,active,mood,hungry,spec,profile,growth}], dataDir, dbPath, schemaVersion, coreVersion}`：出战宠物 + 全部已安装（**单宠物展示、多宠物存储**）。`mood`（shy/friendly/close/devoted）与 `hungry` 是**派生值**，库里只存好感与饿；`growth` 是养成账本（经验/等级/次数/连续天数/解锁，R139），等级由只增的 `xp` 派生。读之前会先结算一次时间流逝（否则「关掉一夜」的宠物在面板上仍显示不饿） |
| `pet.install{spec, atlas?}` | `pet.json` **原文**（字符串；解析与校验都在核心）。**两种格式都收**：我们自己的格式，或 **Codex Pet v1**（`{id, displayName, spritesheetPath}`——核心补齐 8×9 网格、9 个动作与默认行为表；v2 明确报错）。`atlas` 可选 `{file, dataBase64}`：素材只收 **png/webp**、**纯文件名**、≤ 8 MiB，落在 `<data>/pet/packages/<id>/`，库里只记文件名（搬家后仍有效） | `{spec, active, hasAtlas}`；覆盖安装**保留**好感度/饱食度；坏包 → `pet.invalid_package` / `pet.limit_exceeded` |
| `pet.atlas{id}` | — | `{file, dataBase64}` 或 `null`（没有图集）；走 base64 而不是回环 URL，是因为宠物引擎**不依赖**音乐核心的媒体代理。装的时候记过 FNV-1a 64 校验和：文件被改坏/换掉 → `pet.io_error`（渲染层据此退回程序化渲染）；文件整个丢了 → `null`（当没有图集） |
| `pet.tick{petId, dtMs, playing?, elapsedMs?, lyricActive?, trackHash?, pointerX?, pointerY?, clicked?, lookDir?, walkDir?}` | 一帧的输入（只读播放快照 + 指针 + 点击 + 看向哪边 + 往哪边走）。`lookDir` 是 0..15（0 = 正上、顺时针），越界按 16 取模；`walkDir` 是 -1 左 / 1 右（宿主走动时给） | `{frame:{animation,frame,x,y,flip,bubble,hitArea,look,motion}, bubble:{index,key}\|null}`：气泡只给**文案键**；`look` 是 `lookDir` 的原样回传，渲染层据此在两行 look 格里挑一格（只在待机时生效）；`motion` 是当前动画允许的位移能力（`none/walk/crawl`，R139）——宿主据此决定**能不能平移窗口** |
| `pet.setActive{id}` | 切换出战宠物（**单宠物**：换一只就换掉前一只） | `{active}`；未安装 → `pet.not_found` |
| `pet.interact{id, kind}` | `kind` = `feed` / `touch` | `{profile, mood, hungry, growth}`：喂食在冷却内 → `pet.invalid_argument`（消息里带剩余毫秒）；触摸在冷却内**静默忽略**。养成（R139）：**不饿时喂食不加好感**；每天有收益的喂食/触摸次数有上限，超出后仍演动画、只不加分 |
| `pet.remove{id}` | — | `{removed:true, active}`：连带资料与 `packages/<id>/` 素材一起删；删的正是出战宠物时 `active` 变 `null` |

### 行为表能写什么（宠物包作者看这里）

条件（`when`，有限枚举，无表达式）：`idle` / `playing` / `silentFor{ms}` / `lyricActive` /
`pointerNear` / `clicked` / `trackChanged` / **`hungry`**（饿了）/ **`bondAtLeast{tier}`**（好感到档）。

动作（`then`）：`play{animation}` / `say{textKey}` / `face{dir}` / `anchor`。

两条必须知道的语义：

1. **顺序即优先级**：每帧取**第一条**「条件成立且冷却已过」的行为；所以「饿」要写在「待机」前面。
2. **没有匹配就保持当前动画**：想回到待机，就显式写一条 `idle → play(idle)`；
   核心不会替你猜（否则「为什么它一直演那个」会变成玄学）。

序号规则与音乐核心一致：`pet.<动作>`，字典序排列；名字是跨语言 ABI（改名 = 破坏兼容）。

### 图集能怎么排（R93）

`pet.json` 里与画图有关的是三样：`atlas`（文件名）、`atlasLayout`（网格）、`animations[].row`（行号）。

| 字段 | 语义 |
|---|---|
| `atlasLayout{frameWidth, frameHeight, columns, rows}` | 网格图集：每格 `frameWidth × frameHeight`，**一行一个动画**；缺省则按**单行帧条**（总帧数 = 各动画 `frames` 之和，横向等分）解释 |
| `animations[].row` | 该动画在网格里的行号（0 起）；**不写按声明顺序取行**；只能配 `atlasLayout` |
| `animations[].fit{scale, offsetX, offsetY}` | 该行的显示适配（R105）：整行等比缩放（0.25–2.0，默认 1）+ 原图像素微调（不超过一格）。用来对齐「各行素材画得大小不一」；`lookRows` 不受影响 |

校验（失败都是可读原因）：`frames` 不得超过 `columns`；行号必须落在 `rows` 内；有 `atlasLayout` 就必须有 `atlas`；
写了 `row` 就必须有 `atlasLayout`；格子尺寸/行列不得为 0，`columns`/`rows` ≤ 64；
`fit.scale` 必须在 0.25–2.0 之间，`fit` 的偏移不得超过一格。
布局换算在前端一处纯函数里（`src/pet/frame-layout.ts`）：`[动画][帧] → 背景偏移 + 盒子锚点`，DOM 只读结果。

### 版本与体积（R106）

- `version` 必须是语义化版本（`x.y.z`；`1.0`、`v1.2.3`、`1.2.3-rc1` 都收，预发布后缀不参与比较）；
- `minPetCoreVersion` **真的会被比较**：包的版本要求高于本机核心 → `pet.incompatible`（以前只校验非空，
  等于写什么都不影响安装）；留空 = 没要求，老包一个都不会因此装不上；
- `pet.json` 原文上限 **512 KiB**（`MAX_SPEC_BYTES`，超过就是 `pet.limit_exceeded`），
  图集上限仍是 8 MiB；两者都在落库之前检查；
- `pet.state` 带 `coreVersion`，界面据此回答「这个包装得上吗」（调试面板里能看到）。

### 静默条件（R106）

`Condition::SilentFor{ms}` 以前实现成「没在播就算」，`ms` 是个摆设。现在真的按时间累计：
**只有「没在播」的时间才累加**，一恢复播放立刻归零；`ms = 0` 等价于「一停播就算」。

### 打断型动画要演完一遍（R106）

带 `"interrupt": true` 的 `play`（点击 / 换歌）当拍切换，并且**至少演完一遍**（`frames × frameMs`，
夹在 200–2000ms）才允许状态机接管——否则「当前状态是待机」会在 160ms 后把 `jump` 掐掉。
### 动画什么时候换（R105）

- 状态类动画（饿 / 在走 / 在播 / 指针靠近 / 待机 / 好感档）每拍独立算出「应该是什么」，
  **连续满 160ms** 才真的切（防「跑 → 待机 → 跑」抖动）；
- `play` 带 `"interrupt": true` 的行为（点击、换歌）当拍就切；
- 换动画时帧游标归零；`Frame` 的结构不变（渲染层只按 `animation` / `frame` 画）。

### 位移能力 `motion`（R139）

用户报过「坐下的动画还在平移」。修法不是让宿主猜动画名字（名字是自由字符串），而是由动画
**自己声明**位移能力：

| 值 | 含义 |
|---|---|
| `none` | 不许平移（坐下 / 跳 / 失败 / 点击反应 / 播放在原地……） |
| `walk` | 可以水平走动（`runLeft` / `runRight`） |
| `crawl` | 可以贴边爬行（预留；宿主尚未实现竖向/贴边移动） |

兼容规则（**必须保留**）：

- 一个动画都没写 `motion` → 整包按 legacy 处理，全部视为 `walk`（旧包行为不变）；
- 只要有任一动画写了 → 严格模式：未写的动画 = `none`（作者不必逐个补）。

校验：严格模式下 `walking` 行为指向 `motion: none` 的动画、或声明了 `motion` 但没有任何
`walk`/`crawl` 动画，安装时直接 `pet.invalid_package`（不让它到真机上才「坐着滑行」）。
宿主在**同进程**里读 `Engine::motion(id)` 门控窗口平移（不新增命令/事件，也没有一帧延迟）；
门控期间仍会把方向事件发给渲染层，让核心有机会先切到走路动画。

### 养成账本（R139）

`PetGrowth` 存在 `PetProfile.state_json`（不改表结构，坏 JSON / 超长自动退回空账本）：

```json
{"xp": 36, "feeds": 3, "touches": 6, "bestAffection": 15,
 "streakDays": 4, "daysVisited": 4, "lastDay": 20371,
 "todayDay": 20371, "todayFed": 1, "todayTouched": 6,
 "unlocked": ["first-feed"]}
```

- `xp` **只增**；`level = 1 + xp / levelStepXp`（封顶 `maxLevel`），所以好感自然衰减不会掉级；
- 每天第一次进入（`Engine::runtime_mut` 结算）记一次到访：连续天数 +1（断档归 1）；
- 喂食：**不饿时不加好感**；每天有收益次数上限；触摸同理（动作照旧、只是不加分）；
- 解锁：`first-feed` / `feeds-50` / `bond-friendly` / `bond-close` / `bond-devoted` / `streak-7`，
  一次性写入、不回收；`growth` 随 `pet.state` / `pet.interact` 返回。

## 3. 与音乐核心的边界

- 宠物**不**认识 `Track` / `AppPaths` / 音乐库；宿主把播放状态转成 `PlaybackHint`
  （`playing / elapsed_ms / lyric_active / track_hash`）再喂给 `pet.tick`；
- 宠物**不**能暂停/切歌/改音量（ADR 0007 §3 继续有效）；
- 宠物的数据在自己的库里（`<宿主给的目录>/pet.db`），与音乐库分开；
  数据目录迁移会把它一起搬走，并**逐库**做完整性自检（R88 的接缝修复）。

## 4. 守卫现状

| 守卫 | 覆盖范围 | 状态 |
|---|---|---|
| 契约一致性（`scripts/check-commands.mjs`） | 命令清单 ↔ 文档表格 ↔ `PET_COMMAND_NAMES` ↔ 前端字面量；错误码 ↔ 文档 | ✅ 已覆盖（R89 起） |
| 独立性（`scripts/check-pet-independence.mjs`） | 无 `gently-core` / 无 `tauri` / 无仓内相对依赖 / 自带 `pet.db` | ✅ 已覆盖 |
| 界面可达性（`scripts/check-reachability.mjs`） | 每条宠物命令：有服务封装 + 有界面调用（或登记为有意留白 `DELIBERATE_PET`） | ✅ R90 起覆盖；M2 起 **7 条全部有界面入口**（管理面板：state/install/setActive/remove；渲染器：tick/atlas；点击：interact），留白 0 条 |
| 命令分发测试（`pet-core/tests/dispatch.rs`） | 每条登记的命令都真的能分发；未知命令给可读错误 | ✅ |






