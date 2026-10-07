---
status: active
last_verified: 2026-10-07
owner: gently
scope: 当前迭代状态与下一步
token_budget: 950
tldr: 第十一轮：M0 完成（Rust 核心骨架 + 前端桥接与诊断页，端到端实测）；随后立下 **ADR-0005 中立立场**（不内置/不推荐任何第三方资源入口）并完成 M1a——插件清单解析（单文件头部元数据 + 目录包）与 `plugin.preview`（只读不写）。`cargo test` 38/38、`pnpm smoke` 176/176、契约守卫四向一致。
---

# STATE

## 本轮目标

按澄清后的产品定位重整后端形态与契约：不提供服务器、不需要账户服务、桌面端无 web 端、
社区资源（插件/皮肤）靠用户自行 clone / 下载 / 分享后**通用导入**。

## 已完成（第八轮、第九轮）

### 1. 定位与决策
- 三条约束：**不提供服务器**（无账号、无市场后端、无遥测）；将来同步歌单是**用户自己的第三方账号**
  （凭据存本机 keyring，不经我方服务）；**桌面端无 web 端**。
- 新增 `docs/adr/0003-no-server-local-core.md`：取消 HTTP 服务形态，改为「Rust 本机核心 + Tauri IPC」。
  ADR-0001 整体作废；ADR-0002 保留语言选择（Rust），传输层由 axum/HTTP 修订为命令/事件 + specta 绑定。
- 分发机制定为**通用导入**（本地目录 / 压缩包 / URL / 粘贴文本四合一 `ImportSource`）：
  社区仓库由用户自行 clone 后指向目录，**应用不内建 git 客户端**（不要求用户装 git）。

### 2. 契约重写（`docs/contracts/local-core-api.md` + `src/api/index.ts`）
- **约 45 条命令**（v0.1 口径，v0.2 修订见本节第 4 小节）
  + 4 类事件（下载进度、插件健康、导入进度、扫描进度）替代原 41 条 HTTP 端点与 WebSocket；
- 统一信封 `{ok, data|error, traceId}` + 本机错误码表（新增 `plugin.permission_denied`、
  `skin.token_rejected`、`download.disk_full`、`source.auth_expired` 等）；
- **插件模型**：内嵌 QuickJS（贡献者写 JS/TS）；清单声明 `permissions` / `hosts`（网络白名单）/
  `credentials`；安装必须 `plugin.preview` → 用户显式同意 → `plugin.import`；不执行安装脚本、
  不自动更新；凭据只进 OS keyring；
- **皮肤**：惰性 JSON，导入导出即分享；新增**令牌键名白名单**校验（修掉此前「未知键静默忽略」
  的缺口，改为 `skin.token_rejected` 并列出被拒键名）；
- **本机存储**：SQLite + `<appData>/gently/` 目录布局（plugins / skins / downloads / cache / logs）；
  无 Postgres、无 Redis、无队列，长任务用 tokio 任务 + 事件推进度；
- 前端类型同步重写：`src/api/index.ts`（原 `types.ts` / `contract.ts` 合并后删除）。

### 3. 归档与清理
- `docs/archive/server-ts/`（51 个文件 + `ARCHIVE-NOTE.md`）：TS 骨架（41 个 HTTP 端点、JWT、
  幂等、限流、Docker、Postgres/Redis/BullMQ）；其中「清单唯一目录 + 遍历清单的守卫测试」
  「统一信封与错误码映射」「插件清单 permissions/credentials 设计」已迁入新契约；
- `docs/archive/contracts/backend-api-http.md`：旧 HTTP 规范（带弃用横幅，多音源策略被沿用）；
- 同步摘除 `pnpm-workspace.yaml` 的 server 子包、清理 `.gitignore`；锁文件已无 `@gently/server` 残留；
- 清理了 10 个未随任务退出的历史 server 进程（它们以 `server/` 为工作目录，阻塞了目录归档）。

### 4. 契约 v0.2 修订（对照主流源数据软件）

对照 **Legado 的 Tauri 社区书源仓库规范**（`repository.json` + 单文件书源 + cli-testing）与
**MusicFree 插件协议**（单文件 + 头部注释元数据 + 顶层函数）做了评估，结论是 v0.1 有三处硬伤，
据此把契约修订到 **v0.2**（`docs/contracts/local-core-api.md`，`src/api/index.ts` 同步）：

- **插件 ABI 补齐**：4 → **9 个函数**（`search` / `getMediaSource` 必选，其余 7 个可选）。
  v0.1 的 ABI 支撑不了 `catalog.album` / `playlist` / `lyrics` 等命令，那些命令本会永远无法实现；
  函数缺失时对应命令返回 `common.not_implemented` 并隐藏 UI 入口。
- **媒体传输**：新增**本地流代理**。WebView 的 `<audio>` 不能设 `Referer` / `UA` / `Cookie`，
  且需要 Range；`playback.resolve` 改为返回 `ResolvedMedia`（`streamUrl` 指向仅回环的一次性 token 代理，
  `originUrl` / `headers` 只用于排障），代理做头部注入、Range/206 透传、`no-store`，
  并阻断内网/回环/链路本地地址（`media.blocked_address`）；本地文件同通道。
- **订阅分发**：新增 `repository.json` 订阅索引（与 Legado 社区仓库规范同构、字段只增不改）
  + `plugin.subscriptions.*` / `plugin.catalog.list` + `ImportSource{kind:'catalog'}` 一键安装；
  插件主形态改为**单文件 `.js` + 头部注释元数据**，目录包降为高级形态；分发仍不依赖我方服务器。
- **流式搜索**：`catalog.search` 立即返回 `{searchId}`，结果经 `catalog.search.partial` 逐源到达，
  `catalog.search.done` 给跨源合并结果，新增 `catalog.searchCancel`——一个慢源不再拖死整页，
  合并仍在核心完成；`catalog.charts` 由 `catalog.topLists` / `catalog.topList` 取代
  （真实源是任意分类树，排行榜页待改为按源渲染）。

规模：**约 57 条命令 + 8 类事件**；新增错误码 `plugin.invalid_source` / `subscription.fetch_failed` /
`subscription.invalid_index` / `media.proxy_failed` / `media.blocked_address`。并明确
**前端 `src/plugins/**` 不是插件 ABI**（只是 mock 兜底的最小接口）。

### 5. M1a：插件清单与 preview（第十一轮，已完成）

- **清单解析**（`core/src/plugin/manifest.rs`）：单文件头部注释（前 60 行 `// @key value`）与
  目录包 `plugin.json` 统一为 `PluginManifest`；校验 id/version 形状、音质、权限、域名白名单、
  凭据字段；**权限推导**（声明 `@hosts` / `@credentials` 即自动具备对应权限，避免作者漏写导致
  能力静默失效）；未知头部字段只警告；错误带字段级 `details`。
- **能力静态预扫描** + 必选函数（`search` / `getMediaSource`）缺失警告；
  M1b 接入运行时后由真实探测覆盖，预扫描仅用于预览提示、**不作安全判断**。
- **`plugin.preview` 真实实现**（已实现命令 3 → 4）：`paste` / `file` / `dir` 三种来源，
  产出 `{manifest, permissions, credentials, warnings, replacesExisting}`；
  `archive` / `url` / `catalog` 返回 `not_implemented` 并说明「哪个来源 + 已支持哪些」；
  **只读不写**（测试断言 preview 后插件目录仍为空）。
- **中立性落地**（ADR-0005）：不内置任何第三方入口；清理了模拟源里两个伪造的第三方 homepage，
  模拟源改名并标注「不访问网络」；`plugin.subscriptions.*` 保留但无默认值。

### 6. M1a-2：安装与状态（第十二轮，已完成）

- **迁移 0002**：`plugin_state`（清单整体存 JSON + 可查询列 enabled/priority/origin/sha256）
  与 `plugin_config`（乐观并发 revision）。文件在磁盘、状态在库。
- **`plugin.import`**：同意是硬门槛（`consent` 必须为字面量 `true`）；落盘走
  **暂存 → 从暂存副本重新校验 → 原子 rename**；覆盖安装先把旧版本移到 `.trash`，
  失败则把旧版本放回；单文件归一化为 `plugins/<id>/plugin.js`，目录包整体复制
  （跳过符号链接、累计 8 MiB 上限）；入口 sha256 入库；完成后清理空目录。
- **`plugin.list` / `remove` / `setEnabled` / `setPriority`**（已实现命令 4 → 9）；数据库不可用时
  明确失败（`library.io_error` + 原因），不假装装上。
- 测试抓到的真 bug：`RemoveParams` 漏 `rename_all = "camelCase"`，前端 `deleteFiles: false`
  被静默忽略导致误删文件——已修并加了对应断言。

## 验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | 通过（契约 v0.1 → v0.2 重写后均为 0 错误） |
| 冒烟测试 | `pnpm smoke` | **176/176 通过**（原 172 + 桥接层 4 条断言；v0.2 类型同步后复测） |
| 前端接入 | 设置页「本机核心」诊断卡片 + `core.bridge.ts` | 浏览器显示「浏览器模式」并退回 mock；桌面端显示核心版本/平台/数据库状态/统计/数据目录（一键打开） |
| 核心单测 | `cargo test -p gently-core` | **45/45 通过**（信封、26 错误码、57 命令均被路由、目录白名单、迁移幂等、FTS5、清单解析 8 项、`plugin.preview` 8 项、**插件安装/卸载/状态 7 项**） |
| 契约守卫 | `pnpm check:contract` | 文档 ↔ Rust 三处一致（57 命令 / 8 事件 / 26 错误码） |
| Rust 构建 | `cargo build -p gently` | 通过（1m03s，复用既有依赖缓存；产物固定在 `src-tauri/target`） |
| 启动实测 | `cargo run -p gently` | 迁移 0001 应用、WAL 生效、库落在 `%APPDATA%\com.xun.gently\gently.db` |
| **端到端链路** | `pnpm tauri dev`（`GENTLY_LOG=debug`） | 日志出现 `DEBUG dispatch command="system.status" ok=true`：React 挂载 → `probeCore()` → `invoke('core_invoke')` → Tauri 参数解析 → `spawn_blocking` → core 分发 → 信封回传，全链路打通 |
| 前端生产构建 | `pnpm build` | 通过，主包 339.82 KB（gzip 110 KB，+1.45 KB） |
| 残留引用 | 搜 `@gently/server` / `server/src` | 0（配置、锁文件、文档均已清理） |
| 消费方影响 | 全仓搜 `src/api` 导入 | 0——契约是纯类型，UI/store/services 未被波及 |

## 下一步

计划与退出标准见 **`docs/ROADMAP.md`**（M0 骨架与契约 → M1 插件宿主与分发 → M2 播放链路 →
M3 本机库与持久化 → M4 推荐与皮肤 → M5 收口交付）。要点：

| 项 | 结论 |
|---|---|
| Cargo 结构 | workspace：`core`（不依赖 tauri，可独立 `cargo test`）+ `src-tauri`（薄适配层） |
| 存储 | rusqlite（bundled）+ 单写线程 + WAL + FTS5 + `user_version` 迁移（`docs/adr/0004-local-storage.md`） |
| 职责边界 | **前端只做 UI 与渲染；数据处理与算法（含推荐打分）归 core**；同一算法只允许一份实现 |
| 首个插件 | demo 插件（移植现有 mock 源）+ 故意越权的测试插件 |
| **第三方资源立场** | **不内置/不推荐/不预置任何第三方入口**（无默认订阅、无预置仓库、无推荐位）；导入必须由用户提供来源；用户动作前零外部请求；示例只用 `example.com` 占位（ADR-0005，硬约束） |
| 插件形态 | **单文件 JS（头部注释元数据）为主，目录包为高级形式**；分发靠订阅 `repository.json` |
| 媒体传输 | **核心内建仅回环流代理**（Range + 头部注入 + SSRF 防护）；本地文件走同一通道 |

顺序与退出标准：

1. **M0 骨架与契约**：Cargo workspace、信封/错误码（含 `plugin.invalid_source`/`subscription.*`/
   `media.*`）/tracing、`system.*` 真实现、其余 **57 条命令**注册骨架返回 `common.not_implemented`；
   `specta` 生成绑定 + `check-commands` 文档↔注册表一致性守卫；
2. **M1 插件宿主与分发**（最大不确定项）：**单文件 JS + 头部元数据解析**（目录包为高级形态）、
   9 函数 ABI 与能力探测、QuickJS 沙箱 + `hosts` 白名单、六种导入来源 + `preview`/同意/`import`、
   keyring 凭据、**订阅 `repository.json` 索引 + `plugin.catalog.list` + 一键安装**、作者自测 CLI；
3. **M2 播放链路**：**流式搜索**（`searchId` + 事件 + 分源视图）+ 按源分类树渲染排行榜、
   catalog 聚合去重排序 + `playback.resolve` 回退链、**本地流代理（Range/头部注入/SSRF 防护）**、
   前端 catalog/audio 切命令层；
4. **M3 本机库与持久化**（可与 M1/M2 并行）：SQLite 表与迁移（含 `subscriptions`）、
   收藏/歌单/历史、本地扫描 + FTS5、下载任务与事件、**本地文件播放改走同一流代理**（删 Blob/`audio/mp4` hack）；
5. **M4 推荐与皮肤**：推荐画像与打分**迁入 `core/recommend`**（同夹具对比后删除 TS 实现，
   mock 改预置数据）；皮肤令牌白名单校验与导入导出；
6. **M5 收口**：诊断页、错误码→zh/en 文案、`pnpm verify` 一条命令、`pnpm tauri build` 实测出包。

## 风险

- **命令清单仍需逐条确认落地**：`auth.*` 已删、市场写操作改为导入/导出，其余命令待 Rust 侧核对；
- **社区插件是不可信代码**：沙箱与安装期同意是硬要求——不做就等于让用户执行陌生代码；
- **无遥测**：线上问题只能靠本地诊断页与用户主动提供的日志；
- 皮肤令牌键名白名单目前只有契约，尚无实现；推荐算法的 Rust 迁移需防行为漂移（见 ROADMAP §6）；
- **单实例假设**：SQLite 单写线程 + 内存缓存要求单实例，M0 需引入单实例守卫；
- **生态冷启动**：零插件则播放器不可用——**不靠推荐资源解决**（ADR-0005 禁止预置第三方入口）：
  无插件时应用本身可用（本地文件播放/播放器/歌词/皮肤/本地库）+ 插件页给出三种导入方式的中性说明
  （不写具体地址）+ 单文件格式降低作者门槛 + 订阅一键装（用户自填 URL）+ 作者自测 CLI。
- **恶意媒体地址 SSRF**：插件可借本地流代理访问本机/内网——代理层阻断内网/回环/链路本地地址
  （`media.blocked_address`）；
- 视觉 / 交互正确性仍依赖人工走查（环境无法截图）。
