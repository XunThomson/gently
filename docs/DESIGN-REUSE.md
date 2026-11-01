---
status: active
last_verified: 2026-10-31
owner: gently
scope: 现有概念/设计中**可沿用**的东西（第三部分·可整理点）
token_budget: 900
tldr: 不是新方案，是把仓库里已经验证过、值得沿用到安卓端 / pet-core 的概念、契约形态与工程约定列成一份清单，标明「在哪、为什么可复用、复用时要改什么」。新增条目请附代码位置。
---

# 可整理点：可沿用的概念与设计

> 这份文档回答一个问题：**接下来做安卓 UI、pet-core 时，哪些东西已经想清楚了、直接沿用，
> 哪些是桌面专属、必须重做**。只写结论与位置，不重复契约正文
> （正文在 `docs/contracts/local-core-api.md`，架构在 `docs/ARCHITECTURE.md`）。

## 1. 契约形态（建议原样搬到任何新宿主）

| 概念 | 位置 | 为什么可沿用 | 移植时要改什么 |
|---|---|---|---|
| **信封** `{ok, data|error, traceId}` | `core/src/contract/result.rs` | 让「失败」永远是可分支的数据而不是异常；前端所有门面统一返回它 | 无（与语言/平台无关） |
| **错误码是跨语言 ABI** | `core/src/contract/error.rs` ↔ `src/api/index.ts` 的 `CORE_ERROR_CODES` ↔ 契约 §1 | 界面按码取本地化文案，不解析 message；三处比对由 `check:contract` 守住 | 新平台只需要再写一份「码 → 文案」 |
| **单入口命令分发** `core_invoke{command, params}` | `core/src/commands.rs`（`COMMAND_NAMES`） | 命令名可以带点号（`plugin.import`），与契约字面一致；ACL 只需放行一个命令 | 新宿主实现同形的 bridge（安卓 WebView / Tauri 都是 invoke 语义） |
| **事件名冒号分段** | `src/services/core.events.ts` | Tauri 只接受 `[A-Za-z0-9\-/:_]`；点号会让事件**整条丢失** | 无（改名成本远高于遵守约定） |
| **「已实现 / 已登记」可区分** | `IMPLEMENTED` + `is_implemented()` | 未实现的命令回 `common.not_implemented`，前端可隐藏入口；`not_found` 才是 bug | 新平台补自己那份 `IMPLEMENTED` |
| **按源路由表** | `src/services/core.sources.ts` | 桌面上「核心插件」与「前端演示源」并存，必须按源判定走哪条路；缓存要有 TTL + 失效开关 | 安卓端同理（可能还有「系统媒体库源」第三类） |

## 2. 本机核心（core）本身

- **core 不依赖 tauri**：`CoreContext` 只吃 `AppPaths` / `Store` / `EventSink` / `CredentialStore` /
  `HttpTransport` 等 trait 或数据（`core/src/commands.rs`）。这是它能被单测、也能被安卓直接复用的原因；
  `src-tauri` 是薄适配层（一个 `core_invoke` + 两个宿主命令）。**安卓端应照抄这个分层**，
  而不是把能力写进宿主的 Activity/Service。
- **宿主能力清单**（只有这些必须由宿主提供）：`app_restart`（重启）、`web_login`（读 webview Cookie 罐）、
  窗口/文件选择器（`services/window.service.ts`、`file.service.ts`）。其余一律走 core。
- **数据目录由调用方注入**（`core/src/paths.rs::resolve_data_paths`）：桌面按「环境变量 > 指针文件 >
  便携版 > 系统默认」裁决；安卓应换成「应用私有目录 / 用户选的 SAF 目录」，但**同一套 `AppPaths` 形状**可留。
- **回环媒体代理**（`core/src/media.rs`）：`<audio>`/`<video>` 设不了 Referer/UA/Cookie，必须由核心代理；
  一次性 token（30 分钟 TTL）、Range、SSRF 防护都在里面。安卓 WebView 同样需要它（甚至更需要）。
- **凭据落系统凭据库**（`plugin/keyring.rs`，Windows 用 CredRead/CredWrite）：安卓应换成
  EncryptedSharedPreferences / Keystore；接口（`CredentialStore`）不变，`system.status.credentialsBackend` 如实上报。

## 3. 插件/皮肤：社区资源的统一处理套路

- **「预览 → 显式同意 → 安装」三步不可省**（`plugin.preview` / `skin.preview` → 用户勾选 → `install`）。
  两处共用同一个 `ImportSource`（paste/file/dir/archive/url/catalog），前端不需要为每个域写一套导入流程。
- **令牌白名单 + 退役键有界接受**（`core/src/skin.rs` 的 `RETIRED_COMPONENT_TOKENS`）：
  皮肤/主题会随版本演进，**删掉的键不能让旧皮肤整份失效**；新增顶层字段必须同时进 `META_FIELDS`（R87 的坑）。
- **主题包 = JSON + 可选素材**（R87）：素材不进 JSON，`file` 只是包内纯文件名；素材落在宿主侧存储，
  按 `skin:<id>` 绑定。这个「文档 + 素材」的组合模式可以直接沿用到安卓主题包与宠物皮肤。
- **沙箱边界**：插件 JS 只在 QuickJS 内跑、网络限于清单 `hosts`、兼容模式是显式降权并要 TOFU 收敛。
  安卓端不需要新设计，**沿用同一套清单与黑名单**。

## 4. 播放链路（可直接复用，只有一处要补）

- 状态机在 `src/store/slices/player.slice.ts`：`current/queue/candidates/activeSource/failedSources/playbackError`。
  候选回退（`resolveWithFallback`）、失败必须停表 + 说原因、换源是用户动作——这些规则与平台无关。
- 引擎抽象在 `src/services/audio.service.ts`（`load/play/pause/seek/resume/reload/hadError`）。
  R87 的休眠恢复（媒体元素 error + 流地址 TTL）在安卓上**同样会发生**（后台播放、进程被冻结、URL 过期），
  这套「先原地恢复、不行就重新解析并保留进度」的流程建议原样带走。
- 需要补的一处：**后台播放 / 媒体通知**（MediaSession / AudioFocus）。桌面上不需要，安卓必备；
  建议做成 `services/audio.session.ts`，只消费 player 状态（与 `useAudioEngine` 同一层），不改 store。

## 5. 界面层可沿用的结构

| 结构 | 位置 | 可复用点 |
|---|---|---|
| store 切片 + selector hooks | `src/store/**` | 12 个切片按域切分；视图只订阅自己关心的字段（进度下沉到子组件，避免每秒整页重渲染） |
| 主题 token 单一来源 | `theme.config.json` → `tokens.ts` → CSS 变量 | 安卓端只要一份「token → Compose/WebView 变量」的映射；不要另造一套颜色常量 |
| 列表列定义集中 | `src/config/table.config.tsx` | 「业务列表只做组合」的约定；列宽下限必须放得进最小窗口（R53 的坑） |
| 行操作统一构造器 | `src/hooks/useTrackActions.ts` | 「点当前曲目 = 暂停 / 点其他 = 切歌」、下载/收藏/队列的唯一入口，避免每个视图各写一份 |
| 危险操作二次确认 | `useConfirm()` + `ConfirmHost` | 删除/清空/卸载/迁移一律走它；安卓端换成原生对话框也保留这个调用点 |
| 异步列表的请求代号 | `views/favorites/components/source-favorites.tsx`、`store/slices/ranking.slice.ts` | R87 的错位根因；**任何**「按选中项取列表」都要带序号并按序号丢弃 |
| 底部播放条 + 功能抽屉 | `components/shell/player-bar/**` | 信息集中：歌曲信息只在播放条；歌词页只有封面 + 歌词。安卓上可缩成 mini player + 抽屉 |

## 6. 工程约定（比代码更容易被忘掉）

- **守卫脚本**：`check:contract`（文档↔Rust↔前端三处命令/事件/错误码）、`check:reachability`
  （命令必须有界面入口）。新增平台/新命令时这两道守卫最值钱，建议在安卓子项目里复刻同类脚本。
- **陷阱清单**：`docs/GOTCHAS.md` 是「不读就会再踩」的集合；安卓特有的坑（后台限制、SAF 权限、
  WebView 的媒体策略）应该新建同格式的一节，而不是散在聊天记录里。
- **每轮证据**：`docs/STATE.md` 保留「本轮目标 / 做了什么 / 验证 / 未做」，实图放 `release/screenshots/`。
  这套格式在跨会话协作里救过多次「以为做了」。
- **契约有三处硬编码断言**（`contract.rs` / `dispatch.rs` / `plugin_preview.rs` 的命令数）：
  新增命令时一次改全，否则 `pnpm verify` 会红在最后一步。

## 7. 明确**不能**直接沿用的（桌面专属）

- 无边框窗口 / 拖动区 / 最小尺寸与三档外壳（`useShellMode`、`tauri.conf.json`）——安卓没有窗口概念。
- 桌面歌词窗口（第二个 WebView）、画中画（`windowService`）——需要安卓的悬浮窗/通知栏歌词替代。
- WebView 文件选择器 / 本机路径粘贴导入（`<input type=file>`、`path` 来源）——安卓用 SAF + URI。
- 便携版与 `portable.txt`、注册表/凭据管理器——对应 Android 的私有目录与 Keystore。

## 8. 相关文档

- 安卓端落地路径与缺口（工具链、外壳形态、后台播放、SAF）：[`ANDROID-INFRA-ASSESSMENT.md`](ANDROID-INFRA-ASSESSMENT.md)
- 宠物独立模块的边界与接口（pet-core）：[`adr/0010-pet-core-crate.md`](adr/0010-pet-core-crate.md)
- 宠物扩展点的现有约束（2.x 版本线与边界）：[`adr/0007-versioning-and-pet-extension.md`](adr/0007-versioning-and-pet-extension.md)
