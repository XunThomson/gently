---
status: active
last_verified: 2026-10-07
owner: gently
scope: 本机核心开发计划（M0–M5）
token_budget: 1700
tldr: **已按契约 v0.2 修订**：按 M0 骨架与契约 → M1 插件宿主（QuickJS 沙箱 + 单文件 JS/订阅分发）→ M2 播放链路（流式搜索 + 本地流代理）→ M3 本机库与持久化 → M4 推荐与皮肤 → M5 收口交付 推进。职责边界已定：**前端只做 UI 与渲染，数据处理与算法（含推荐打分）归 core**；存储用 rusqlite（bundled）+ 单写线程 + WAL + FTS5（见 ADR-0004）；前端始终保留浏览器 mock 兜底（预置数据，不含第二套算法）。
---

# ROADMAP：本机核心开发计划

## 0. 起点与终点

**起点（已完成的事实）**：前端 UI 交付完毕（mock 数据，`pnpm smoke` 172/172、主包 338 KB）；
契约已重写为本机核心命令清单（`docs/contracts/local-core-api.md` + `src/api/index.ts`），
并经 **v0.2 修订**为约 57 条命令 + 8 类事件（补齐插件 ABI、媒体传输、订阅分发、流式搜索）；
TS 后端形态已作废归档。Tauri 侧目前是标准模板（单 crate、只有一个 `greet` 命令、无 Cargo workspace）。

**终点**：`pnpm tauri dev` 起的应用里，曲库/播放/本地库/推荐/下载/插件/皮肤全部由 Rust 本机核心提供，
前端只在 `src/services/**` 换成命令调用；社区插件与皮肤通过通用导入安装并受沙箱约束。

## 1. 架构落点

```
gently/
├── Cargo.toml            workspace（新增）
├── core/                 纯 Rust 核心库：无 tauri 依赖 → 可 cargo test、可复用
│   ├── contract/         CoreResult 信封、错误码、DTO（serde + specta 派生）
│   ├── store/            SQLite（rusqlite + 单写线程 + WAL + FTS5 + 迁移）
│   ├── plugin/           QuickJS 宿主、元数据/清单校验、权限白名单、凭据读写
│   ├── subscription/     订阅索引（`repository.json`）拉取、校验与本地缓存
│   ├── catalog/          跨源聚合、去重、候选排序、缓存、流式搜索编排
│   ├── library/          收藏 / 歌单 / 播放史 / 本地扫描（lofty）
│   ├── recommend/        口味画像与打分（由 TS 迁入，见 M4）
│   ├── playback/         播放地址解析与回退链、下载任务
│   ├── media/            本地流代理（仅回环 + 一次性 token + Range/头部注入 + SSRF 防护）
│   └── skin/             皮肤文档校验（令牌键名白名单）与存储
├── src-tauri/            薄适配层：把 core 暴露为 #[tauri::command] + 事件
└── src/                  React 前端（唯一改动点是 services/）
```

**职责原则（已确认）**：**前端只做 UI 与渲染；数据处理与算法归 core。**

| 前端（TS） | 核心（Rust） |
|---|---|
| UI 状态、列表、歌词渲染、交互 | 曲库聚合/去重/候选排序/缓存、上游 HTTP |
| 主题令牌合并与 CSS 变量注入（渲染管线） | 皮肤**文档校验**（令牌白名单）、皮肤存储 |
| i18n 文案、错误码 → 用户提示 | 错误码产生与语义、日志与诊断 |
| mock 兜底（**预置数据**，浏览器 dev 用） | SQLite、本地扫描、下载落盘、keyring、插件沙箱 |
| — | 推荐画像与打分、播放解析与回退 |

> **插件 ABI 由核心定义**（契约 §5）：前端 `src/plugins/**` 只是浏览器 mock 兜底用的最小接口
> （search + resolveUrl），**不是插件协议**，不得据此推断插件能力。

> 依据：`src/utils/recommend.ts` 的打分属「数据处理」，M4 迁入 `core/recommend`，
> 相关断言从 `pnpm smoke` 搬到 `cargo test`；前端 mock 兜底改为预置推荐数据，
> **不保留第二套算法**（避免同一逻辑两份实现漂移）。

**存储**（见 `docs/adr/0004-local-storage.md`）：rusqlite（bundled，无系统依赖）+
单写线程串行化写入 + WAL + prepared statement 复用 + FTS5 全文检索 + `user_version` 迁移。

**命令层薄封装**：`src/services/core.bridge.ts` 统一 `invoke`，把信封转成「永不抛异常」的返回值；
浏览器环境（`pnpm dev` 无 Tauri）检测不到核心时返回 `available: false`，`services/**` 退回 mock——
**前端必须始终能在浏览器里跑起来**，否则 UI 开发会被 Tauri 绑死。

## 2. 里程碑

每个里程碑的**退出标准**都必须可执行验证；任一里程碑结束时要保持
`pnpm typecheck` + `pnpm smoke` 全绿、`cargo test` 全绿。

工作量级：**M0 4–6 / M1 10–14 / M2 7–10 / M3 5–8 / M4 5–7 / M5 3–5（合计约 34–50 人日）**；
M1/M2 相对早期估算的增长来自订阅分发（索引 + 一键安装 + 作者自测 CLI）与本地流代理。

### M0 骨架与契约（S，约 4–6 人日）——**已完成**（仅视觉确认待人工）

#### 已完成（本里程碑 Rust 侧）
- **Cargo workspace**：`core`（不依赖 tauri）+ `src-tauri`（薄适配层）；
  `.cargo/config.toml` 把产物固定在 `src-tauri/target`，复用已有 5 GB 依赖缓存（不重编）。
- `core/contract`：`CoreResult` 信封（手写 Serialize，输出布尔判别字段 `ok`）、`CoreError`
  + **26 个错误码**（字符串与文档/TS 三处一致，测试逐个锁定）、`COMMAND_NAMES`（**57 条**）、
  system 域 DTO。
- `core/commands`：**命令分发**（见下方偏差说明）；`system.status` / `system.paths` /
  `system.reveal` 真实实现（含 `reveal` 的**受管目录白名单**校验）；其余 54 条返回
  `common.not_implemented`；未登记命令返回 `common.not_found`（两者语义必须可区分）。
- `core/store`：rusqlite（bundled，**版本用本机 registry 已缓存的 0.32.1**）+
  WAL/foreign_keys/busy_timeout + `user_version` 迁移框架 + `meta` 表（迁移 0001）。
- `core/events`：`EventSink` 抽象（Tauri 实现转发到前端）+ 8 个事件名常量。
- `src-tauri`：启动时建目录、开库（失败降级不阻塞启动）、初始化 tracing；
  只注册**一个** Tauri 命令 `core_invoke`。
- `scripts/check-commands.mjs`（`pnpm check:contract`）：比对**文档 ↔ Rust 清单**三处
  （57 命令 / 8 事件 / 26 错误码），已接入脚本命令。
- **验证**：`cargo test -p gently-core` **22 项全绿**（含 FTS5 可用性、目录白名单、
  信封形状、错误码字符串、每条契约命令都被分发认识）；`pnpm check:contract` 三处一致；
  `cargo build -p gently` 通过；**实跑 `cargo run -p gently`**：迁移 0001 应用、WAL 生效、
  数据库落在 `%APPDATA%\com.xun.gently\gently.db`。

#### 两处相对计划的偏差（已决策，非遗漏）
1. **用单一分发入口替代 57 个 `#[tauri::command]`**：Tauri 的命令名取自 Rust 函数名，
   **无法表达 `plugin.import` 这种带点的名字**，而契约名是跨语言 ABI。因此只注册 `core_invoke`，
   参数 `{command, params}`，由 core 按契约名 `match` 路由。
   副作用（正面）：契约名原样保留、无需命名转换规则、命令名清单只有一处权威（core），
   守卫脚本只需比对文档 ↔ core；`spawn_blocking` 让同步 SQLite/文件操作不占用异步运行时。
   代价：失去 Tauri 逐命令的参数反序列化，改由 core 统一解析并把 serde 原因放进 `details`（更贴合错误码哲学）。
2. **`specta`/`tauri-specta` 类型生成推迟到 M1**：M0 还没有真实 DTO（只有 system 域三个），
   现在引入 codegen 只是增加版本/API 风险而不产生防漂移收益；命令名的一致性已由
   `check:contract` 守卫。**M1 出现第一批真实 DTO 时接入**，届时 `src/api/index.ts`
   退化为生成产物。ROADMAP 的 M1 条目已承接此事。

#### 前端（M0 收尾，已完成）
- `src/services/core.bridge.ts`：全应用唯一调用 IPC 的地方；`invokeCore(command, params)`
  经 `core_invoke` 分发，**永不抛异常**（IPC reject 归为 `common.internal`）；
  浏览器（无 Tauri）下 `coreAvailable() === false`，返回 `common.unsupported_platform`
  并由 `services/**` 退回 mock。
- 设置页新增「本机核心」诊断卡片（`views/setting/components/diagnostics-card.tsx`）：
  运行环境、核心版本、平台、数据库就绪状态、条目统计、数据目录 + 一键打开数据/日志目录。
  浏览器下显示「浏览器模式」并说明 mock 数据来源，不发任何请求。
- i18n zh/en 各 19 个新键；样式复用 `setting.module.css`（顺带补上被引用却不存在的
  `.hint`，并新增 `.path`）。
- 冒烟测试从 172 → **176 项**：新增桥接层四条断言（浏览器判定、不抛异常、错误码、
  traceId 恒存在）。

#### M0 验证（全部实测）
| 验证 | 结果 |
|---|---|
| `cargo test -p gently-core` | 22/22（信封、26 错误码、57 命令均被路由、目录白名单、迁移幂等、FTS5 可用） |
| `cargo build -p gently` / `cargo run -p gently` | 通过；启动日志显示迁移 0001 应用、WAL 生效、库落在 `%APPDATA%\com.xun.gently\gently.db` |
| `pnpm check:contract` | 四向一致（57 命令 / 8 事件 / 26 错误码 / 前端桥接命令名） |
| `pnpm typecheck` / `pnpm smoke` / `pnpm build` | 0 错误 / **176 项全绿** / 通过（主包 339.82 KB，+1.45 KB） |

> 唯一未验证项：设置页在真实窗口里的**视觉**表现（本环境无法截图）——
> 启动链路与数据已由日志与 `system.status` 覆盖，外观需人工打开设置页确认。

### M1 插件宿主与分发（L，约 10–14 人日；全计划最大不确定项）——**进行中（M1a 已完成）**

#### M1a 清单与预览（已完成）
- `core/src/plugin/manifest.rs`：单文件头部注释（前 60 行 `// @key value`）与目录包 `plugin.json`
  两种形态统一为 `PluginManifest`；校验 id/version 形状、音质、权限、域名白名单、凭据字段；
  **权限推导**（声明 `@hosts`/`@credentials` 自动具备对应权限，避免作者漏写导致能力静默失效）；
  未知头部字段只警告；错误码 `plugin.invalid_source` / `plugin.invalid_manifest` 且带字段级 `details`。
- **能力静态预扫描**（找顶层 `function <name>`）+ 必选函数缺失警告；
  M1b 接入运行时后由真实能力探测覆盖，预扫描仅用于预览提示、不作安全判断。
- `plugin.preview` **真实实现**（已实现命令 3 → 4）：支持 `paste` / `file` / `dir` 三种来源，
  产出 `{manifest, permissions, credentials, warnings, replacesExisting}`；
  `archive` / `url` / `catalog` 明确返回 `not_implemented` 并带上「哪个来源 + 已支持哪些」。
  **只读不写**（有测试断言插件目录在 preview 后仍为空）。
- 中立性落地：清理了模拟源里两个**伪造的第三方 homepage**，模拟源改名标注「不访问网络」
  （ADR-0005）。

#### M1a-2 安装与状态（已完成）
- 迁移 **0002**：`plugin_state`（**清单整体存 JSON** + 可查询列 enabled/priority/origin/sha256，
  清单格式演进不必每次写迁移）与 `plugin_config`（乐观并发 revision，冲突 → `common.conflict`）。
- `plugin.import`：**同意是硬门槛**（`consent` 必须为字面量 `true`，否则 `common.invalid_argument`）
  → **暂存 → 从暂存副本重新校验 → 原子 rename**；覆盖安装先把旧版本移到 `.trash`，
  失败则把旧版本放回；单文件形态归一化为 `plugins/<id>/plugin.js`，目录包整体复制
  （跳过符号链接、累计体积上限 8 MiB）；入口文件 sha256 入库；成功后清理 `.staging`/`.trash` 空目录。
- `plugin.list`（按 priority → name）/ `plugin.remove`（`deleteFiles` 缺省 true）/
  `plugin.setEnabled` / `plugin.setPriority`（0~9999，越界即拒并给 `details`）。
- 数据库不可用时**明确失败**（`library.io_error` + 原因），不假装装上。
- 过程中测试抓到的真 bug：`RemoveParams` 等结构体漏了 `rename_all = "camelCase"`，
  导致前端传 `deleteFiles: false` 被静默忽略 → 误删文件。

#### M1 剩余
1. **M1b 运行时**：`rquickjs` 宿主 + 能力白名单（受限 `fetch` 仅 `@hosts`）+ 超时/内存上限 +
   错误映射 + 参考插件（移植现有模拟源）+ **故意越权**的测试插件；
2. **M1c 订阅分发**：`plugin.subscriptions.*` + `plugin.catalog.list` + 一键安装 +
   从 `plugins/*.js` 生成 `repository.json` 的作者工具 + **导入界面的第三方免责声明**
   （无默认订阅列表，ADR-0005）。
- **承接 M0 推迟项**：引入 `specta`/`tauri-specta`，在第一批真实 DTO（插件清单已是第一批）
  落地时生成 `src/api/generated.ts`；命令名一致性仍由 `pnpm check:contract` 守卫。

#### M1 详细范围（供剩余三片执行时对照）
- 包形态：**单文件 `.js` + 文件头注释元数据为主体**（前 60 行解析 `@name` / `@id` / `@version` /
  `@author` / `@url` / `@description` / `@tags` / `@qualities` / `@hosts` / `@credentials` /
  `@minCoreVersion`；缺失或格式错 → `plugin.invalid_source`）；**目录包（`plugin.json` + `entry`
  + 可选 assets）为高级形态**，非法 → `plugin.invalid_manifest`。
- 插件 ABI（9 个函数）：`search` / `getMediaSource` 必选，其余 7 个可选；
  **能力探测**——函数缺失时对应命令返回 `common.not_implemented` 且 UI 隐藏入口。
- QuickJS 宿主：每插件独立 runtime；注入受限 `fetch`（仅 `hosts` 白名单、仅 HTTPS）、
  `crypto`、`console`、插件私有 `storage`、`credentials.get`；单次调用超时 + 内存上限；
  违规 → `plugin.permission_denied`，异常/超时 → `plugin.runtime_error` 并记健康度。
- 导入：六种来源（单文件 / 目录 / 压缩包 / URL / 粘贴文本 / 订阅条目 `{kind:'catalog'}`）
  → `plugin.preview`（展示权限与凭据需求）→ 用户显式同意 → `plugin.import`；
  记录来源与校验和；**不执行安装脚本、不自动更新**。
- 订阅与仓库索引：解析 `repository.json`（与 Legado 社区仓库规范同构，字段只增不改，`sha256` 有则校验）
  → `plugin.subscriptions.list/add/remove/refresh`（索引本地缓存，失败保留旧索引并报
  `subscription.fetch_failed`）+ `plugin.catalog.list` 列可安装条目（带 `installed` / `updateAvailable`）；
  `{kind:'catalog'}` 实现**一键安装**。分发不依赖我方服务器，**且不预置任何订阅**（ADR-0005）。
- 作者自测 CLI：校验单文件头部元数据、必选函数与 `@hosts` 合法性，并可生成 `repository.json`
  （对应 Legado 的 cli-testing / prepare_public_repository），供作者发布前自测。
- 管理：`remove` / `setEnabled` / `setPriority` / `reload` / `config.get|put` / `checkUpdate`。
- 凭据：OS keyring（`keyring` crate）按插件隔离；`credentials.status` 只回 present。
- 参考插件：把现有模拟源移植成单文件 JS 插件作为示例与测试夹具；另加一个「故意越权」的
  测试插件验证拒绝路径。**示例插件不得解析任何真实音源**（只播随包测试音频）。
- 前端：插件页接入导入向导 + 权限同意弹窗 + **第三方免责声明**（样式走 token，文案 zh+en；
  空列表时给出三种导入方式的中性说明，不写任何具体地址）。
- **退出标准**：导入 demo 插件后能搜索并解析出可播地址；越权插件被拒并给出 `permission_denied`；
  超时插件被隔离且不影响其他源；头部元数据缺失的文件被拒并报 `plugin.invalid_source`；
  用户自填订阅可一键安装（含 sha256 校验）；**首次安装前界面无任何预置来源**。

### M2 播放链路垂直切片（M，约 7–10 人日）

- `catalog.search` **流式**：立即返回 `{searchId}` → `catalog.search.partial` 逐源到达 →
  `catalog.search.done` 给出跨源合并结果（标题+歌手归一化去重、候选按 `plugin.priority` 排序）；
  `catalog.searchCancel` 取消慢源；前端加**分源视图**（合并会误合，必须可见来源）。
- `catalog.track` / `album` / `playlist` / `lyrics` / `recommend`：归一化 + 缓存到 `cache/`；
  能力缺失时按 `common.not_implemented` 隐藏入口。
- 排行榜改为**按源的分类树渲染**：`catalog.topLists{source}` → `catalog.topList{source, id, page?}`
  取代 v0.1 的 `catalog.charts` 固定枚举（**前端排行榜页需改**）。
- `playback.resolve`：按候选顺序回退，全部失败返回 `data: null`；`playback.report` 记历史。
- **本地流代理**（`core/media/`）：仅绑定回环 + 一次性 token；转发 `Range` 与 `206`、
  注入源声明的请求头（`Referer` / `User-Agent` / `Cookie`）、`Cache-Control: no-store`；
  对回环/内网/链路本地地址返回 `media.blocked_address`（SSRF 防护；媒体地址由上游返回，
  不受 `@hosts` 约束，必须在代理层拦截）。
- 前端：`services/catalog.service.ts` + `services/audio.service.ts` 切到命令层，
  保留 mock 开关；音源筛选/候选切换沿用现有 UI。
- **退出标准**：播放一首由插件解析的曲目；一个源失败自动切下一个；全失败退回模拟时钟
  （用越权/超时插件构造这两个场景）；**代理能播需要 `Referer` 的媒体**（并可拖动进度即 Range）；
  **指向 `127.0.0.1` 的媒体地址被拒并报 `media.blocked_address`**；
  慢源不阻塞首屏——最快源结果先渲染，取消后不再有事件到达。

### M3 本机库与持久化（M，约 5–8 人日；与 M1/M2 可并行）

- 表：`favorites` / `playlists` / `playlist_tracks` / `play_history` / `local_tracks` /
  `plugin_state` / `plugin_config` / `download_tasks` / `skins` / `subscriptions`；
  索引对齐分页游标键；`local_tracks` 建 **FTS5** 索引（标题/歌手/专辑）供本地检索。
- `library.favorites.*` / `playlists.*` / `history.*` 真实实现；本地扫描
  （`lofty` 读元数据 + 时长）与 `library.scan.progress` 事件。
- **本地文件播放走同一条流代理**（`playback.resolve` 的 `streamUrl` 指向本地文件），
  删除前端现有的 Blob / `audio/mp4` hack（`services/audio.service.ts`）。
- `download.*`：本地任务、落盘、暂停/恢复、`download.progress|done|error` 事件。
- 前端：`services/library.service.ts` + 下载切片切换。
- **退出标准**：扫描目录 → 入库 → 播放 → 收藏/建歌单/记历史 → 重启后数据仍在；
  下载完成文件落到目标目录且事件驱动 UI 进度；1 万文件扫描 < 10s；
  本地文件播放经代理可拖动进度且无 Blob 路径残留。

### M4 推荐与皮肤（M，约 5–7 人日）

- **推荐算法迁入 `core/recommend`**：把 `src/utils/recommend.ts` 的口味画像（播放次数取对数、
  12h 半衰期衰减、收藏/歌手加权）与可解释理由（tag / artist / trending）按**同一套行为**重实现，
  并把它现有的断言移植为 `cargo test`；前端删除该算法，`src/mock/` 改为预置推荐数据。
- `recommend.home` / `similar` / `feedback`：Rust 读播放史与候选池打分；反馈写库供下次消费。
- `skin.*`：实现**令牌键名白名单**校验（`skin.token_rejected` + 列出被拒键名）、
  导入/导出（文件 / URL / 粘贴）、激活与删除；前端皮肤市场接命令层。
- **退出标准**：推荐理由可解释且随播放史变化（与旧 TS 实现行为一致，用同一组夹具对比）；
  从文件与 URL 导入皮肤均可用；含未知令牌键的皮肤被拒并明确列出键名。

### M5 收口与交付（S，约 3–5 人日）

- 设置页「诊断」：版本、路径、计数、日志目录一键打开；日志按天滚动、保留 7 天。
- 统一错误提示：错误码 → zh/en 文案（i18n 全覆盖，无死键）。
- `pnpm verify` = typecheck + smoke + `cargo test` + check-commands。
- 打包验证：`pnpm tauri build` 出包并实测启动、导入插件、播放、扫描。
- 文档同步：`docs/STATE.md` / `ARCHITECTURE.md` / 契约文档与 ADR 状态更新。
- **退出标准**：安装包在干净环境可启动并完成一次完整链路（导入插件 → 播放 → 扫描 → 收藏）。

## 3. 横切要求

- **契约一致性**：命令/事件只认 `docs/contracts/local-core-api.md`；改契约必须同步
  Rust 注册表、`src/api`、文档三处，由 `check-commands` 兜底。
- **单一职责**：前端不实现数据处理与算法；核心不碰 UI/样式。**同一算法只允许一份实现**
  （迁移时先搬后删，禁止长期双份）。
- **前端不可退化**：任何阶段浏览器 mock 模式都要能跑（无核心时 `available: false`）。
- **样式与文案**：新 UI（导入向导、同意弹窗、诊断页）走 theme token + i18n zh/en，不硬编码。
- **测试策略**：算法与数据逻辑在 `core` 用 `cargo test`（含迁移、**插件头部元数据与目录包清单两类校验**、
  去重排序、画像打分）；Tauri 层只做 smoke 级验证；前端 `pnpm smoke` 并新增桥接层断言（两条路径返回形状一致）。
- **性能预算**（契约 §11）：搜索首屏（最快源）< 1s、单源搜索 P95 < 2s、本地 FTS5 检索 P95 < 50ms、
  插件调用超时 8s、扫描 1 万文件 < 10s（后台 + 进度事件）。

## 4. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | Cargo 结构 | **workspace：`core` + `src-tauri`**；core 不依赖 tauri，可独立 `cargo test` |
| 2 | 存储 | **rusqlite（bundled）+ 单写线程 + WAL + FTS5 + `user_version` 迁移**（ADR-0004） |
| 3 | 职责边界 | **前端只做 UI 与渲染，数据处理与算法（含推荐打分）归 core** |
| 4 | 首个插件 | **demo 插件（移植现有 mock 源）+ 故意越权的测试插件**；真实上游源放到 M2 之后 |
| 5 | 插件形态 | **单文件 JS + 文件头注释元数据 + 订阅源为主，目录包（`plugin.json`）为高级形式** |
| 6 | 分发 | **借 Legado 社区仓库的 `repository.json` 字段约定（字段只增不改）**；不依赖我方服务器 |
| 7 | 媒体传输 | **核心内建仅回环流代理**（Range 透传 + 请求头注入 + SSRF 防护），本地文件同通道 |

## 5. 明确不做（本计划范围外）

- 不提供服务器、账号、市场后端、遥测（ADR-0003）。
- 不内建 git 客户端：社区插件/皮肤由用户自行 clone 后指向目录。
- **不内置、不推荐、不预置任何第三方资源入口**（订阅清单/插件仓库/示例链接）；
  导入一律由用户提供来源，用户动作之前不发起任何外部请求
  （`docs/adr/0005-neutral-third-party.md`，属硬约束）。
- 不做音频转码/串流转封装（若将来需要，属独立决策）。
- 不做多设备同步（触发条件见 ADR-0003）。

## 6. 风险与未知

| 风险 | 影响 | 缓解 |
|---|---|---|
| QuickJS 宿主 API 设计反复 | M1 工期最大不确定项 | 先定最小 API（fetch/storage/credentials）并用 demo 插件验证，再扩 |
| 推荐算法迁移造成行为漂移 | 推荐质量回退且难察觉 | 迁移时保留同一组夹具，Rust 与旧 TS 输出逐条对比后再删 TS 实现 |
| 真实上游音源不稳定/需登录 | 不影响架构，影响可用性 | 参考插件用 demo；上游逻辑全部隔离在插件里，可随时替换 |
| 社区插件质量参差 | 用户遇到崩溃/异常 | 沙箱 + 超时 + 健康度自动禁用 + 导入校验和；日志留痕 |
| 无遥测导致问题难定位 | 线上排障靠用户 | M5 诊断页 + 一键打包日志 |
| 前端双模式（mock/核心）维护成本 | 两套路径易漂移 | 桥接层单一入口 + smoke 断言两条路径的返回形状一致 |
| **生态冷启动：零插件则播放器不可用** | 首启即空壳，用户不会等 | **不靠推荐资源解决**（ADR-0005 禁止预置第三方入口）：① 无插件时应用本身可用（本地文件播放/播放器/歌词/皮肤/本地库）；② 插件页给出三种导入方式的中性说明（不写具体地址）；③ 单文件格式降低作者门槛 + 订阅一键装（用户自填 URL）；④ 作者自测 CLI 降低插件质量门槛 |
| **恶意媒体地址 SSRF**（插件让核心代理去打本机/内网） | 本机服务被探测或滥用 | 代理层阻断内网 / 回环 / 链路本地地址（`media.blocked_address`，`core/media/`） |
| **我们比主流多了沙箱与同意流程，摩擦过大社区会绕开** | 生态流向无摩擦的替代品 | 保持一键安装 + 只保留**一个权限摘要确认框**（不做多层向导） |
