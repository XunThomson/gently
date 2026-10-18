---
status: active
last_verified: 2026-10-10
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

### M0 骨架与契约（S，约 4–6 人日）——**已完成**（打包版逐页实图见 `release/screenshots/`）

#### 已完成（本里程碑 Rust 侧）
- **Cargo workspace**：`core`（不依赖 tauri）+ `src-tauri`（薄适配层）；
  `.cargo/config.toml` 把产物固定在 `src-tauri/target`，复用已有 5 GB 依赖缓存（不重编）。
- `core/contract`：`CoreResult` 信封（手写 Serialize，输出布尔判别字段 `ok`）、`CoreError`
  + **26 个错误码**（字符串与文档/TS 三处一致，测试逐个锁定）、`COMMAND_NAMES`（**59 条**）、
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

### M1 插件宿主与分发（L，约 10–14 人日；全计划最大不确定项）——**已完成**（沙箱 / 清单 / 四种导入来源 / 兼容模式 TOFU / 订阅索引，接口与权限在打包版上都实测过）

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

#### M1b 运行时与沙箱（已完成）
- **每个插件一个专用线程 + 同步执行模型**：QuickJS 单线程且不 `Send`，专用线程既满足类型约束
  又隔离故障；宿主 `fetch` 是阻塞调用，插件写 `async function` 也能用——宿主用
  `Ctx::execute_pending_job()` **手动排空微任务队列**直到结果落地（不需要 async 运行时）。
- **沙箱能力**：空白全局对象 + bootstrap 显式安装 `fetch`（仅 HTTPS、仅 `@hosts` 白名单，
  后缀域匹配但不误命中 `evil-example.com`）/ `console` / `storage`（插件私有 kv）/
  `credentials.get`（需声明权限，keyring 里没有就返回空）；bootstrap 结束后**删除全部
  `__host*` 原始入口**（测试断言插件侧看到的都是 `undefined`）。
- **限制**：JS 内存上限 64 MiB / 栈 1 MiB / 单次调用 8s（截止时间 + `set_interrupt_handler`，
  纯 CPU 死循环在 300ms 测试里被及时中断）；响应体上限 4 MiB 并标记 `truncated`；
  重定向手动跟随且**每一跳重新过白名单**。
- **能力探测优于静态预扫描**：安装期只能看到 `function name(` 写法；运行时通过 JS 侧
  `__collect()`（用 `eval(name)` 读全局词法环境）识别 `function` / `const ... =>` /
  `globalThis.x =` 三种写法，结果写回清单快照。
- **错误映射**：越权 → `plugin.permission_denied`；能力缺失 → `common.not_implemented`；
  抛错/超时/语法错误（加载期）→ `plugin.runtime_error`。
- 新增 `plugin.reload{id}`（已实现命令 9 → 10）：安装只落盘，**建运行时发生在这里**。
- 说明：OS keyring 仍是内存实现（`keyring` crate 未在本地缓存），M1c 接入；
  计划中的「参考插件 + 故意越权测试插件」已由测试内的 fixture 覆盖（真实随包 demo 插件放 M1c）。

> **插件格式双轨制**（`docs/adr/0006-plugin-format-dual-track.md`）：自有单文件 ABI 为默认路径；
> 另设**默认关闭**的兼容模式支持 MusicFree / LX 生态的 CommonJS 插件。兼容模式允许访问任意公网
> HTTPS 域名（**本机/内网在任何模式下都拒绝**），实际域名记入观测台账以便固化为白名单。
> 已完成：CommonJS 环境、`module.exports` 探测、`@compat` 与域名策略、缺依赖的可执行报错、
> **`require` 垫片**（固定清单 `he` / `axios` / `dayjs` / `crypto-js`；axios 转宿主 `fetch`、
> crypto-js 的 MD5/SHA256 由宿主 sha2/md-5 计算，垫片不新增能力）、
> **返回形状适配**（`[...]` / `{items}` / `{isEnd, data}` / `{isEnd, musicList}`，含 MusicFree 的 `duration` 数字秒）、
> **流程接线**（`plugin.preview` / `plugin.import` 的 `compat` 开关；无头部元数据时用 `probe` 合成清单，
> 界面在同意前与已安装列表里都明示权限弱化）、
> **TOFU 收敛**（观测台账 `plugins/.hosts/<id>.json` + `plugin.compat.observed` / `plugin.compat.confirm`：
> 用户确认后固化成 `hosts` 白名单并关闭兼容模式，白名单只能来自观测结果）。
> 待完成：MusicFree 的 `env.getUserVariables()` 接入凭据体系。
#### M1c 订阅分发——**已完成**（核心索引缓存 + 界面订阅面板；导入来源必须由用户主动提供）
- 迁移 **0003** `subscriptions` 表；索引原文缓存在 `<data>/subscriptions/<id>.json`（断网可用）；
  订阅 id 由 URL 的 sha256 派生（稳定、无 uuid 依赖）。
- **索引按不可信输入处理**：`fileName` 必须是纯文件名（拒绝 `..` / 路径分隔符 / `C:`，防目录穿越）、
  `downloadUrl` 必须 HTTPS 且**不得指向回环/内网**（防 SSRF）、`sha256` 必须 64 位；任何非法条目
  都会让整份索引被拒（避免「安静地少一半条目」），并把**字段级细节**写入订阅的 `lastError`。
- 命令：`plugin.subscriptions.list/add/remove/refresh` + `plugin.catalog.list`（已实现 10 → **15**）。
  添加订阅会立即尝试刷新一次；**刷新失败保留旧索引**并返回 `subscription.fetch_failed`。
- `{kind:'catalog'}` 已接入 `plugin.preview`（下载但**不落盘**）与 `plugin.import`（校验 sha256 后才落盘，
  不符 → `plugin.import_failed` 并给出实际校验和）；来源记为 `catalog`（含 subscriptionId 与 fileName），
  `plugin.catalog.list` 据此标记 `installed` / `updateAvailable`。
- **作者自测 CLI**（已完成）：`cargo run -p gently-core --bin plugin-tool -- check <file.js>` 校验
  头部元数据/必选函数/`@hosts` 写法并打印能力与警告；`index <dir> --base-url …` 由目录生成
  `repository.json`（含 sha256/fileSize/updatedAt，`--skip-invalid` 可选）。
  逻辑放在 `plugin::authoring`（CLI 只做薄壳），因此有测试覆盖；**生成的索引会被客户端同款
  校验**（闭环）。实跑 CLI 当场抓到真 bug：`@url` 是社区约定的主页字段，解析器却只认 `@homepage`
  → 已把两者都认。
- **随仓库示例插件**（已完成）：`examples/plugins/gently-demo.js` + `examples/plugins/README.md`。
  示例**不声明任何网络白名单、不索要凭据**，`getMediaSource` 恒返回 `null`（不解析任何真实音源），
  只演示 ABI 与沙箱用法；有测试断言它始终合法且「不联网」（ADR-0005）。
- **`{kind:'url'}` 导入已实现**：核心下载 URL 直链（仅 HTTPS、非内网、体积受限），
  预览只读、安装后来源记为 `url`。（`archive` 压缩包在 R15 补上，见 M1 收尾。）
  过程中旧测试暴露出「url 曾被当作未实现」的过期断言，更新后补了带 mock 传输的确定性用例
  （并顺带确认真实传输层可用）。
- **导入界面**（已完成）：插件页新增「本机核心插件」面板——粘贴文本 / 网络地址两种来源 →
  `plugin.preview` 展示**权限、凭据需求、警告、是否覆盖** → 用户显式勾选同意 → `plugin.import`；
  另有已安装列表（名称/版本/启用状态）与**常驻第三方免责声明**。浏览器（无 Tauri）下不请求任何东西，
  只提示需要桌面端。界面不预置任何来源、不出现「官方/推荐」措辞（ADR-0005）。
  压缩包导入（`archive`）与文件/目录选择需要原生文件选择器（`tauri-plugin-dialog`），留待后续。
- **管理动作已接入界面**：已安装列表支持上移/下移（整表重排后按 10 递增回写优先级——默认优先级相同，
  交换数值无效）、启用/停用、重载、卸载（**走 `useConfirm()` 二次确认**，AGENTS 约束 11）；
  安装成功后自动 `reload` 一次，插件立刻可用。
- ⚠️ **已知行为缺口（M2 必须做）**：**应用启动时不会加载已启用插件**——插件状态在库里，但运行时是
  空的，因此重启后必须点一次「重载」才可用。M2 需要在启动时对 `enabled` 的插件逐个 `load`
  （并做失败容忍：单个插件加载失败不影响启动）。
- **M1 收尾（R15）**：`archive`（压缩包）导入已完成——`core/src/plugin/archive.rs`
  只开 `zip` 的 deflate 后端（离线缓存里只有这些），解压后**归一化成目录包 / 单文件两种既有形态**，
  因此安装路径没有分叉；防解压攻击的限制（条目数 / 总大小 / 路径穿越 / 符号链接）写在契约里，
  5 项集成测试锁定（单文件包、目录包 + 拍平、zip-slip 拒绝、zip bomb 拒绝、多入口与空包报错）。
  前端插件页新增「本机路径」来源（压缩包 / 单文件 / 目录包三选一）。
- **M1 收尾（R17）**：靠新加的失败日志（dispatch 记错误码）在**打包版实测**中发现并修掉两个
  真实兼容缺口——`require('x').default` 互操作、MusicFree 函数名别名映射
  （`getMusicInfo`/`getMusicSheetInfo`/`getTopListDetail`）；修完后真实兼容插件的
  `catalog.topLists` 返回 `ok=true`。
- **M1 收尾（R16）**：MusicFree 的**用户变量**接入凭据体系——`module.exports.userVariables`
  在合成清单时转成凭据字段（并自动补 `credentials` 权限），沙箱提供
  `env.getUserVariables()` / `env.userVariables` / `env.os` / `env.appVersion` / `process{…,env}`；
  只回清单声明过的键、只在有凭据权限时回值。**ADR-0006 的待完成清单至此清空。**
  **仍缺两项**（都不是设计缺口）：
  1. **macOS / Linux 的凭据库**：Windows 已在 R19 接上系统凭据管理器（`windows-sys` 直调），
     其它平台 `open()` 返回不支持 → 退回进程内存储，并在 `credentialsBackend` 里如实上报；
  2. **原生文件/目录选择器**（`tauri-plugin-dialog` 不在离线缓存；界面用「粘贴路径」替代）。

#### 历史：M1 早期剩余项（已完成）
1. **M1c 订阅分发**：`plugin.subscriptions.*` + `plugin.catalog.list` + 一键安装 +
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

### M2 播放链路垂直切片（M，约 7–10 人日）——**已完成**（`playback.resolve` + 回环代理 Range/头部注入/SSRF、SeekBar 拖拽、循环模式、候选回退）

#### M2a 跨源搜索聚合与流式推送（已完成）
- `core/src/catalog.rs`：`catalog.search` **立即返回 `searchId`**；每个源一个线程并发调用，
  逐源推 `catalog:search:partial`，协调线程收集后**在核心内合并**并推 `catalog:search:done`
  （契约承诺：合并只在核心完成）。`catalog.searchCancel` 通过共享 `AtomicBool` 取消。
- **不信任插件输出**：`source` 强制为插件 id、`id` 规范成 `source:rawId`、缺失字段给兜底值、
  缺 `title` 的条目**丢弃并计数**（`dropped`），整源不会因个别脏数据失败。
  同时接受 `[...]` 与 `{items:[...]}` 两种返回写法，`duration` 支持 `mm:ss`。
- **候选顺序 = 优先级**：合并按 (标题+歌手) 归一化分组，`candidates` 按 `priority` 升序
  （与播放回退顺序一致）。
- **按需加载**：`ensure_loaded` 在搜索前把「已启用」的插件装进沙箱——**解决了此前记录的重启缺口**
  （用户不必再手动点重载）；单个插件加载失败只记录并跳过，不影响整体。
- **禁用立即生效**（测试抓到的真 bug）：已加载但被停用的插件此前仍会参与搜索，
  现在以库中状态为准在每次搜索时过滤。
- 已实现命令 15 → **17**（`catalog.search` / `catalog.searchCancel`）。
- **服务层已切到核心（视图零改动）**：catalogService.searchAll / resolveUrl 优先走核心（核心内跨源合并 / 回环代理地址），核心不可用或核心里没有该音源时**自动退回模拟音源**，浏览器预览行为不变；resolveUrl 新增 trackRef() 统一 source:rawId 引用。视图与 store 未改动（替换点仍是 services/**）。
- **前端门面（已完成）**：`src/services/core.catalog.ts` 提供 `coreSearch`（把流式事件
  适配成 Promise + 逐源回调，含超时兜底与取消）与 `coreResolveUrl`（只返回 `streamUrl`，并注明
  `originUrl` 不可直接播放）。**无桌面宿主时一律返回 null**，由调用方退回 mock；冒烟测试锁定这两条。
  替换 `catalog.service.ts` 内部实现与视图（流式分源视图）留作下一步——避免同时改动数据形状与渲染逻辑。
- **详情类命令（M2b，已完成）**：新增 `core/src/catalog_detail.rs`——`catalog.track{ref}` /
  `album{source,id}` / `playlist{source,id}` / `topLists{source}` / `topList{source,id,page?}` /
  `recommend{source}` / `lyrics{ref,withTranslation?}`（已实现命令 20 → **27**）：
  - 复用搜索那套归一化（`catalog::normalize_track`）与形状适配（`plugin::list_items`），
    社区形状（`albumItem`/`sheetItem`/`musicList`/`rawLrc`）直接可用；
  - **能力缺失 → `common.not_implemented`**（UI 隐藏入口）、未安装/已禁用 → `common.not_found`
    （与搜索的「禁用立即生效」一致）；引用格式错误 → `common.invalid_argument`；
  - `catalog.track` 的 `id` 强制回到请求里的 `ref`（引用必须稳定），并包成 `GroupedTrack`
    让视图复用同一套渲染；
  - `catalog.topList` 用社区协议的 `isEnd` 推导 `hasMore`/`nextPage`，缺字段不猜「还有下一页」；
  - **缓存到 `cache/catalog/`**（详情 6h、榜单 24h，原子写）：缓存键带齐影响结果的参数
    （页号、是否要翻译），读坏/过期一律回到插件；`cache/` 按契约可随时整目录删除；
  - 歌词**不在核心解析成行**：核心只交原文（`{format, content, translated?}`），
    行解析是纯展示问题，由前端唯一一份 `src/utils/lyrics.ts` 完成（R11 落地：LRC / 纯文本 /
    译文按时间戳对齐），核心不塞 UI 细节。
- **M2 剩余**：**已清零**——排行榜按源分类树（R13）、专辑/歌单详情页（R14）、
  歌词走 `catalog.lyrics`（R11）、`playback.report` 记历史（M3）全部完成。
  本轮还顺手修掉封面渲染的跨来源差异（`utils/cover.ts`：图片地址 / 渐变 / 空值三条路径）。

### M2 播放链路垂直切片（原计划范围，供剩余部分对照）

- `catalog.search` **流式**：立即返回 `{searchId}` → `catalog:search:partial` 逐源到达 →
  `catalog:search:done` 给出跨源合并结果（标题+歌手归一化去重、候选按 `plugin.priority` 排序）；
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

### M3 本机库与持久化（M，约 5–8 人日；与 M1/M2 可并行）——**已完成**（SQLite + FTS5、本地扫描与内嵌封面、收藏/歌单/历史、下载管理）

- **M3a 已完成（收藏 / 歌单 / 播放历史）**：迁移 **0004** 建 `favorites` / `playlists` /
  `playlist_tracks` / `play_history` 四张表；`core/src/store/library.rs` 负责读写、
  `core/src/library.rs` 负责命令层（已实现命令 27 → **34**）：
  - **快照存库**（`track` JSON 列）：插件可能被卸载或改接口，列歌单不该依赖插件在线；
    快照由调用方的 `track` 参数带来，缺了退化成占位曲目（核心不为了补标题去调插件）；
  - 引用 `source:trackId` 是去重键，参数接受字符串或 `TrackRef` 对象；
  - 历史**每次播放留一行**（`playCount` 是累计次数）；歌单 `save` 为整体覆盖（顺序 = 传入顺序、
    重复引用只留一次），`delete` 级联删曲目；
  - 分页用 `(时间戳, 主键)` 复合游标，`nextCursor` 不透明；`limit` 1~500（缺省 50）。
- **M3b 已完成（本地曲库）**：迁移 **0005** 建 `local_tracks` + **FTS5**（`trigram` 词元化，中文子串可搜；
  1~2 字查询退回 LIKE）；`core/src/store/local.rs`（批量写入 + 快速重扫索引 + 检索 + 游标分页）与
  `core/src/local_library.rs`（`library.local.scan/list/remove`，已实现命令 34 → **37**）：
  - 扫描只认音频扩展名，**大小没变就不重读标签**（1 万文件重复扫描秒回）；
    读不到标签的文件照样入库（标题退回文件名）；清理只针对**本次范围内**的路径
    （非递归扫描不会误删子目录——测试抓到的真 bug）；
  - 进度经 `library:scan:progress{dir, found, percent}`（先数一遍文件拿总数）；
  - 检索走 FTS5；`remove` 缺省**只移出曲库**，`deleteFile: true` 才删文件且只接受音频扩展名；
  - 元数据用 **symphonia**（`lofty` 不在本机 registry 缓存里，离线不可得）。
- **M3c 已完成（本地播放链路）**：`playback.report`（写播放历史，与 `library.history.push` 同一实现，
  已实现命令 37 → **38**）；**本地文件改走同一条回环流代理**——`StreamTarget` 分远端/本地，
  `publish_local` 只接受音频扩展名（白名单与扫描共用一份），代理支持 `Range`/`206`/`416`
  与按扩展名的 `Content-Type`，响应头不泄漏路径；`playback.resolve` 对 `local:` 引用直接发布文件，
  文件被删则继续回退。前端因此可以彻底去掉 Blob hack（服务层切换待做）。
- **M3d 已完成（下载）**：迁移 **0006** `download_tasks` + `core/src/download.rs`（已实现命令 38 → **44**）：
  六条命令 + 三个事件；建任务立刻返回、后台线程流式写 `.part` → 完成后 rename；
  **暂停/续传**（`Range`，上游忽略 Range 时从头写）；文件名来自曲目、真实扩展名按媒体地址改写；
  `remove` 缺省只删记录（文件是用户的资产）；下载地址与播放共用同一套公网 HTTPS/防内网校验。
  `HttpTransport` 新增 `download`（`Start` + `Chunk` 事件式流式接口，默认实现明确报错）。
- **M3 剩余**：已清零——下载/本地库/收藏/歌单/历史都走核心，**Blob/`audio/mp4` hack 已在 R11 删除**
  （`Content-Type` 改由回环代理按扩展名补齐，`effective_content_type` 4 项单测）。
  **R28 补上一个一直漏掉的东西**：上面这些能力都在核心里做好了，但 `library.local.scan`
  **没有任何界面入口**——桌面上「本地音乐」页永远是空的（mock 只在浏览器预览出现），
  用户根本没法把自己的音乐加进来。现在本地音乐页常驻扫描面板（目录手填/粘贴、每行一个、
  可含子目录、扫描中显示 `library:scan:progress` 进度、结束后显示统计并强制重读列表），
  扫描失败按错误码说明原因。这条也提醒了一次：**「命令有前端封装」不等于「功能能用」**，
  契约守卫查得到封装，查不到入口。

### M4 推荐与皮肤（M，约 5–7 人日）——**已完成**（推荐画像零出网；皮肤三层校验 + 导入导出）

- **M4a 已完成（推荐迁入核心）**：迁移 **0008** `recommend_feedback` + `core/src/recommend.rs`
  （已实现命令 50 → **53**）：画像与打分与旧前端 `src/utils/recommend.ts` 同一套行为
  （权重、衰减、理由优先级、强度归一化逐条对齐，7 项单测从 TS 断言移植）；
  **候选只来自本机数据**（本地曲库 / 收藏 / 历史 / 自建歌单）——ADR-0005 把「推荐」列进
  「用户动作之前零外部请求」，有测试断言 `recommend.home` 期间零出网；源侧推荐仍是显式命令
  `catalog.recommend{source}`；`recommend.similar` 支持 `TrackRef` 或 `{albumId}` 种子；
  `recommend.feedback` append-only 落库并在下次打分时消费（like/unlike/skip/complete）。
- **M4b 已完成（皮肤）**：迁移 **0007** `skins`（整份文档存库）+ `core/src/skin.rs`
  （已实现命令 44 → **50**）：白名单**唯一来源是 `theme.config.json`**（`include_str!` 编进核心，
  不在 Rust 里抄令牌名）；三层校验（结构 / 键名 → `skin.token_rejected` 全部列出 / 值类型）；
  用户皮肤恒 `builtin: false`；激活状态存 `meta.skin.active`；导入 `paste`/`file`/`url`（复用防 SSRF 校验）；
  导出 `json` / `file`（`<data>/skins/<id>.json`）。`ImportSource` 提升到契约层（插件与皮肤同构）。
- **前端已接线（R10）**：**删除 `src/utils/recommend.ts`**（打分只剩核心一份，浏览器用
  `src/mock/recommend.mock.ts` 的预置数据）；`core.skin.ts` + `skin.service.ts` 落地——
  桌面端导入走 `skin.preview`（校验 + 警告）→ `skin.install`（落盘），失败时列出**被拒的令牌键名**
  （新增 i18n `skin.importRejected`）；ui 切片的 `loadSkins` / `setThemePreset` / `removeSkin`
  分别同步 `skin.list` / `skin.setActive` / `skin.remove`，导出用核心落盘原文（浏览器序列化兜底）。
- 表：`favorites` / `playlists` / `playlist_tracks` / `play_history` / `local_tracks` /
  `plugin_state` / `plugin_config` / `download_tasks` / `skins` / `subscriptions`；
  索引对齐分页游标键；`local_tracks` 建 **FTS5** 索引（标题/歌手/专辑）供本地检索。
- **M4c 已完成（R29 端到端接上「会学习的推荐」）**：核心的 `recommend.feedback` 之前**从没被调用**过
  ——画像只消费播放次数与时间（不看 `playedSec`），「听 5 秒就切」与「完整听完」在画像里没有区别。
  现在：推荐卡片「不感兴趣」= `skip` + `progress: 0`（立刻从列表移除），
  播放器在**切歌/停止/播完**时按进度报 `skip(<0.5)` / `complete`（**暂停不算**倾向）；
  推荐页另加「来自当前音源」一栏（`catalog.recommend`，按源路由，源没实现就不显示）。
  这一轮同时新增 `scripts/check-reachability.mjs`：**把「界面走不到的能力」做成守卫**，
  它正是抓出上面那条没接线的工具（见 M5）。
- **退出标准**：推荐理由可解释且随播放史变化（与旧 TS 实现行为一致，用同一组夹具对比）；
  从文件与 URL 导入皮肤均可用；含未知令牌键的皮肤被拒并明确列出键名。—— 均已满足。

### M5 收口与交付——**已完成**（代码侧：`pnpm verify` 五道关卡 + 打包版逐条实测；只剩「联网打 MSI/NSIS」与「人工听一次扬声器」两件环境受限项）

- **M5a 已完成（插件域收尾）**：`core/src/plugin_admin.rs` 落地最后 6 条命令
  （`plugin.config.get/put`、`plugin.credentials.set/clear/status`、`plugin.checkUpdate`），
  **契约 60 条命令全部点亮**（R54 新增 `catalog.lyricsSearch`、R56 新增两条缓存命令，现为 63 条）：配置乐观并发（冲突带 `details.current`、不改动已存值、64 KiB 上限）；
  凭据只读写清单声明过的键、`status` 只回「是否已配置」（命令层没有读值出口）；
  检查更新只比对来源（url 下载比对版本+sha256 / catalog 比对本地索引）**绝不自动更新**。
  **已知缺口**：凭据落点仍是内存实现（`keyring` crate 不在离线 registry 缓存里）→ 重启失效，
  已在契约与 STATE 写明。
- **前端服务层切换（R9–R14，已完成）**：本机库读取与写入切到核心（`core.library.ts` + `library.service`
  桌面端优先 / 浏览器退回 mock；写入为乐观更新 + 落核心；补了 `library.history.clear` → 契约 **60** 条）；
  R10 完成下载页、插件管理、皮肤市场、推荐页，并把手写历史的路径从 `library.history.push`
  换成 `playback.report`（在「放完/切走/暂停/停止」时上报**真实秒数 + 实际播成的音源**，
  `recordPlay` 只留乐观 UI）；R11 完成歌词（`catalog.lyrics` + `src/utils/lyrics.ts`）与
  删除 `services/audio.service.ts` 的 Blob/`audio/mp4` hack；R12 完成插件**凭据/配置面板**与
  **订阅源面板**（订阅内一键安装仍走「预览 → 显式同意 → 安装」）；R13 排行榜按源分类树；
  R14 专辑/歌单详情页 + 封面渲染收口（`utils/cover.ts`）——**前端服务层切换至此全部完成**。
- **M5 剩余**（都是收口项，不含新命令）：
  - ~~统一错误提示：错误码 → zh/en 文案（i18n 全覆盖，无死键）~~ **已完成（R11）**：
    `errors` 命名空间 26 个码 + `src/i18n/errors.ts` 的 `errorText()`，冒烟守卫「每个码都有翻译」。
  - ~~`pnpm verify` = typecheck + smoke + `cargo test` + check-commands~~ **已完成（R11）**：
    `scripts/verify.mjs`，离线默认给 cargo 加 `--offline`。
  - ~~设置页「诊断」：版本、路径（数据 + 日志）、计数、目录一键打开~~ **已完成（R11）**；
    **日志按天滚动、保留 7 天已在 R17 真正落地**（`tracing-appender` 写
    `<data>/logs/gently.log.<日期>` + 启动清理 7 天前，之前只有目录没有写入）。
  - 打包验证：**R17 完成离线部分**——`pnpm package:portable` 产出便携版 zip（含 SHA256），
    解压后运行实测：迁移 8 条、UI 挂载即发出真实命令且全 `ok=true`、真实兼容插件按需加载成功。
    **剩下 MSI/NSIS 安装包**：需要联网下载一次 WiX/NSIS 工具链（本机 `Invoke-WebRequest`
    与 Tauri CLI 都超时），联网后 `pnpm tauri build` 即可。
    **R52 把这份交付物又冻结验了一遍**：zip 解到另一个目录 → 内层 exe 哈希与 `.sha256` 一致 →
    用解出来的 exe 冷启动全新数据库（8 条迁移、`schema_version=8`、凭据后端
    `windows-credential-manager`）→ `GENTLY_LOG=debug` 下启动命令全 `ok=true` →
    交付版主题市场里内置卡片不再有「删除皮肤」。即「用户拿到手的那一份」本身就是验过的那一份。
  - 文档同步：`docs/STATE.md` / `ARCHITECTURE.md` / 契约文档与 ADR 状态更新（每轮都在做）；
    **README 已在 R17 从 Tauri 模板换成真正的项目入口文档**。
- **打包版实测驱动的修复（R23–R37）**：真实封面接入（R23）、皮肤裁决收成一处（R24）、
  假宿主冒烟（R25）、核心单测隔离（R26），以及 **R27 的两个「只有真跑打包版才会暴露」的问题**：
  ① **事件名带点号被 Tauri 拒绝**（只接受字母数字与 `- / : _`）→ 桌面上 8 个事件全部静默丢失
  （流式搜索只能等超时、下载进度永远不动；命令返回值正常所以测试全绿）——契约名改成冒号分段，
  并把字符集约束钉进 Rust 单测 + 契约守卫（事件升为四处比对）+ 冒烟；
  ② **内置演示源被送去问核心** → 「核心里一个音源都没装」这种正常状态被显示成源故障
  （`插件未安装：mock`）——改为**按源路由**（`core.sources` + TTL 缓存），核心不认识的源走本地实现，
  核心回 `common.not_found` 只当「不认识」；`searchIn` 对核心源不再静默退回演示源。
  之后每轮都是同一条路：**在真实打包版里跑一遍**，把「测试测不到但用户撞得到」的地方补掉
  （R28 扫描入口、R31 曲目详情、R32 插件链路、R34 本地播放路由、R35 播完结算、R36 播放态复核、
  R37 本地内嵌封面 + 表格缩略图）。
- **用户实测报来的四个 bug（R53）**——再一次证明「命令全绿 ≠ 用户能用」：
  ① `.m4s`（B 站下载的音频，ISO-MP4 容器）不在扫描白名单里 → 目录里只有它时 `scanned=0`，
  界面只能显示「还没有本地音乐」；补 `m4s`/`m4b`/`m4r`，并新增 `ignored`（非音频文件数）
  让「有文件但都不是音频」与「空目录」不再显示成同一句话。
  ② UI：表格列宽下限合计 832 放不进最小窗口的内容区 612（「大小/操作」被切到窗口外），
  且 `tauri.conf.json` **没有默认窗口宽度**（Tauri 默认 800 被 `minWidth 900` 顶到 900，
  装完第一次打开正好是最窄布局），播放条 `@media (max-width:900px)` 又整块藏掉右侧控件
  → 下限收到 598、窄窗只收音量与秒数、默认窗口 1280×800。
  ③ 兼容模式把**字符串 id** 交给收**条目对象**的 MusicFree 详情函数 → 真实插件
  `catalog.topList` 报 404、`getMediaSource` 报 `plugin.runtime_error`（能搜、能看榜单、一播就挂）
  → 核心留下**插件原始条目的进程内快照**（LRU、不落盘）并原样交回，沙箱再把字符串包成 `{id}`。
  ④ 三个假音源**无条件**注册、插件列表把演示源与占位项合并进核心清单 → 演示数据一律只在
  浏览器预览出现（见上面「前端不可退化」那条的反向规则）。
- **R54 三个窗口 / 导航 bug + 下载设置**：最大化与向下还原共用图标（`isMaximized` + resize 订阅 +
  `IconRestore`）、歌词页重复压历史（`shouldOpenNowPlaying` 守卫）、`decorations:false` 拖不动
  （`data-tauri-drag-region="deep"` + `allow-start-dragging`）；设置页下载卡片从占位值改成真设置
  （目录 / 默认音质 / 缺档策略 / 并发上限，store 用 `pump()` 排队）。
- **R55 歌词搜索与时间轴校正**：核心新增 `catalog.lyricsSearch`（契约第 61 条命令：跨源搜歌 → 取词，
  每源一线程、12s 整体截止、共用歌词缓存）；歌词页加「搜索歌词」面板（显示来源 / 曲目 / 首行，
  点「使用」替换当前歌词）与逐曲目持久化的 `±0.5s` 校正；`pnpm smoke` 319、核心单测 219。
- **R56 播放缓存与离线优先**：新增 `core/src/cache.rs`——播放成功后后台把曲目补进
  `<data>/cache/media/`（原子 rename + sidecar，单文件 256 MiB / 总量 1 GiB，超出按最旧淘汰）；
  `playback.resolve` 在插件解析**之前**查缓存，命中即以回环代理播放并返回 `fromCache: true`
  （断网 / 插件停用/卸载仍可播）；歌词缓存 TTL 提到 30 天且缓存命中不依赖插件；
  新增 `system.cacheStatus` / `system.cacheClear`（契约 63 条）与设置页缓存卡片（占用 + 分类清理）。
  顺带修掉「播放不看插件启停状态」的真 bug。`pnpm smoke` 322、核心单测 220。
- **R57 桌面歌词**：`tauri.conf.json` 的第二个窗口 `desktop-lyrics`（无边框 / 置顶 / 跳过任务栏 /
  启动隐藏，URL `index.html?window=desktop-lyrics`；`main.tsx` 按 query 分派）；主窗口工具栏开关 +
  窗口服务（显示时摆到屏幕底部居中）；跨窗口用 `gently:lyrics:update` / `gently:lyrics:closed`
  事件同步当前行 / 下一行 / 播放态 / 歌词来源 / 主题模式（行变化立即推 + 1s 心跳）；歌词窗口支持
  A−/A+ 字号、拖动、关闭，复用 `activeLyricIndex`。`pnpm smoke` 326。
- **退出标准**：安装包在干净环境可启动并完成一次完整链路（导入插件 → 播放 → 扫描 → 收藏）。
  **R20 把这套链路自动化了**（`core/tests/e2e_chain.rs`：走 `dispatch`、真的按 Range 取代理地址、
  重开库验证持久化）；**R30 又把它在真实打包版上人肉点了一遍并留了截图**
  （`pnpm ui:capture`：截屏 + 驱动界面，`release/screenshots/`）；
  **R43 则把「干净环境 + 一次会话」这个前置条件也补上了**：清空数据目录后，一次会话里连着走完
  启库 → 扫描（`local_tracks=3`）→ 播放本地曲目（回环 206）→ 收藏 → 导入插件 → 流式搜索 →
  播放插件曲目（详情/歌词/代理）→ 收藏插件曲目，库里最终 `favorites=2`（本地 + 插件各一）、
  `plugin_state=1`（明细与截图见 `docs/STATE.md` 第四十三轮）。
  剩下「安装包」与「扬声器真的响」两步仍需联网打包与人工听一次。

## 2.5 1.x 收口与 2.x 桌面宠物（预留）

版本线见 `docs/adr/0007-versioning-and-pet-extension.md`：`0.x` 是开发线；**1.0.0** 只在
「待完成项 1–6 落地 + 7 拍板后实现或明确不做 + `pnpm verify` 全绿 + 打包版逐条实测」之后发布；
`1.x.y` 只做完善与兼容修复；`2.0.0` 才引入桌面宠物。是否把版本号提前提到 `1.0.0` **待拍板**。

| 1.x 待完成项 | 当前状态 |
|---|---|
| 1. 歌词搜索 + 来源 + 时间轴校正 | **第一刀完成**（R55）：`catalog.lyricsSearch`、歌词页搜索面板、逐曲目 ±0.5s 偏移 |
| 2. 缓存与离线优先 | **第一刀完成**（R56）：播放缓存 + 缓存优先 + 设置页缓存管理；自定义上限/预热策略待补 |
| 3. 下载相关逻辑 | 目录 / 默认音质 / 缺档策略 / 并发上限已完成（R54）；余下见下 |
| 4. 桌面歌词 | **第一版完成**（R57）：独立置顶窗口、跨窗口同步、字号/拖动/关闭、主题跟随 |
| 5. 版本规划与 pet 接口 | **完成**（R58）：ADR-0007 + `src/pet/` 预留接口 + `PetHost` |
| 6. OAuth2 第三方授权 | **未开始**：先做授权抽象，再落 B 站收藏夹（不同第三方策略） |
| 7. 主题控制面板 | **待拍板**：是否提供、性能预算；未拍板前不动手 |

**2.x 宠物（已预留，不在 1.x 实现）**：`src/pet/` 的 `PetDefinition` / `PetContext` / `PetHost`
已在 R58 落地，当前没有内置宠物；接口约束（纯本地、只读播放快照、无商店、性能预算）
写在 ADR-0007，2.x 实现具体宠物时不得绕过这些边界。

## 3. 横切要求

- **契约一致性**：命令/事件只认 `docs/contracts/local-core-api.md`；改契约必须同步
  Rust 注册表、`src/api`、文档三处，由 `check-commands` 兜底；**事件名一律冒号分段**
  （Tauri 事件名不接受点号，否则事件整条丢失），事件清单是文档 ↔ Rust ↔ 前端类型 ↔ 前端常量四处比对。
- **能力可达性**：契约守卫查「有没有前端封装」，`check-reachability` 查「**界面走不走得到**」——
  两层都要过。有实现有封装却没人调用的能力必须要么接上界面、要么写进脚本白名单并说明理由
  （R28 的 `library.local.scan`、R29 的 `recommend.feedback` / `catalog.recommend` 都是这条查出来的）。
- **单一职责**：前端不实现数据处理与算法；核心不碰 UI/样式。**同一算法只允许一份实现**
  （迁移时先搬后删，禁止长期双份）。
- **前端不可退化**：任何阶段浏览器 mock 模式都要能跑（无核心时 `available: false`）。
  **反过来也成立（R53）**：mock/演示数据**只属于浏览器预览**——桌面上（有 Tauri 宿主）
  演示音源根本不注册，服务层在核心读失败时返回空并如实报错，**不拿 mock 冒充用户数据**；
  「只有没有核心才退回 mock；核心在却读失败时返回空」这条规则对每一个门面都适用。
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
