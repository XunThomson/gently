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

### M0 骨架与契约（S，约 4–6 人日）

- **契约 v0.2 已定稿**（`docs/contracts/local-core-api.md`：约 **57 条命令 + 8 类事件**、
  统一错误码表；前端类型同步在 `src/api/index.ts`），本里程碑落地其骨架。
- 建 Cargo workspace，拆 `core` 与 `src-tauri`（`core` 不依赖 tauri，便于单测）。
- `core/contract`：`CoreResult<T>` / `CoreError` / 错误码枚举（serde 重命名对齐契约字符串，
  含 `plugin.invalid_source` / `subscription.*` / `media.*`）、`traceId`（接入 `tracing` span）、
  数据目录解析。
- `core/store`：rusqlite 初始化（WAL、外键、`user_version` 迁移框架），空 schema 起步。
- Tauri 命令层：`system.status` / `system.paths` / `system.reveal` **真实实现**；
  其余命令按 v0.2 注册为骨架（含 `plugin.subscriptions.*` / `plugin.catalog.list` /
  `catalog.searchCancel` / `catalog.topLists` / `catalog.topList`），返回 `common.not_implemented`。
- `specta`/`tauri-specta` 生成 `src/api/generated.ts`；`scripts/check-commands.mjs`
  从契约文档表格抽取命令名，与 Rust 注册表比对（不一致直接失败，纳入 CI）。
- **退出标准**：`pnpm tauri dev` 启动；设置页显示 `system.status` 输出；
  `check-commands` 通过（57 条命令名一致）；未实现命令返回 `common.not_implemented` 而非 reject。

### M1 插件宿主与分发（L，约 10–14 人日；全计划最大不确定项）

- 包形态：**单文件 `.js` + 文件头注释元数据为主体**（前 60 行解析 `@name` / `@id` / `@version` /
  `@author` / `@url` / `@description` / `@tags` / `@qualities` / `@hosts` / `@credentials` /
  `@minCoreVersion`；缺失或格式错 → `plugin.invalid_source`）；**目录包（`plugin.json` + `entry`
  + 可选 assets）为高级形态**，仅在需要多文件/资源/构建产物时使用，非法 → `plugin.invalid_manifest`。
- 插件 ABI（9 个函数）：`search` / `getMediaSource` 必选，`getTrackInfo` / `getAlbumInfo` /
  `getPlaylistInfo` / `getLyric` / `getTopLists` / `getTopList` / `getRecommend` 可选；
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
  `{kind:'catalog'}` 实现**一键安装**。分发不依赖我方服务器。
- 作者自测 CLI：校验单文件头部元数据、必选函数与 `@hosts` 合法性，并可生成 `repository.json`
  （对应 Legado 的 cli-testing / prepare_public_repository），供作者发布前自测。
- 管理：`remove` / `setEnabled` / `setPriority` / `reload` / `config.get|put` / `checkUpdate`。
- 凭据：OS keyring（`keyring` crate）按插件隔离；`credentials.status` 只回 present。
- 参考插件：把现有 mock 源（`src/plugins/builtin/mock-source.ts`）移植成单文件 JS 插件，
  作为示例与测试夹具；另加一个「故意越权」的测试插件验证拒绝路径。
- 前端：插件页接入导入向导 + 订阅/仓库浏览 + 权限同意弹窗（样式走 token，文案 zh+en）。
- **退出标准**：导入 demo 插件后能搜索并解析出可播地址；越权插件被拒并给出 `permission_denied`；
  超时插件被隔离且不影响其他源；**从订阅一键安装成功**（含 sha256 校验）；
  **头部元数据缺失的文件被拒并报 `plugin.invalid_source`**。

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
| **生态冷启动：零插件则播放器不可用** | 首启即空壳，用户不会等 | 单文件格式降门槛 + 订阅一键装 + **随仓库至少提供 1 个真实可用源（demo 不够）** + 作者自测 CLI |
| **恶意媒体地址 SSRF**（插件让核心代理去打本机/内网） | 本机服务被探测或滥用 | 代理层阻断内网 / 回环 / 链路本地地址（`media.blocked_address`，`core/media/`） |
| **我们比主流多了沙箱与同意流程，摩擦过大社区会绕开** | 生态流向无摩擦的替代品 | 保持一键安装 + 只保留**一个权限摘要确认框**（不做多层向导） |
