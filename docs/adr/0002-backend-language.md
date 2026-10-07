---
status: proposed
last_verified: 2026-10-07
owner: gently
scope: 后端实现语言（本地 sidecar 形态）
token_budget: 1100
tldr: 后端定位为桌面端本机 sidecar、不对外服务，ADR-0001 的「云服务」前提不成立，因此改用 Rust（axum + serde/utoipa + sqlx + wasmtime）：单二进制无运行时依赖、可与 src-tauri 同进程、内存与分发成本低一个量级、音频与本地文件处理是强项。HTTP 契约、41 条接口清单与前端替换点不变。
---

# ADR 0002：后端实现语言改用 Rust（本地 sidecar 形态）

> ⚠️ 传输层已被 `docs/adr/0003-no-server-local-core.md` 修订：本 ADR 初稿按「本地 HTTP 服务」
> 选型（axum / utoipa / 限流），但产品确认为**不提供服务器**后，本机核心改以 **Tauri IPC
> 命令与事件**对外（无 HTTP、无端口）。下表与迁移清单已同步更新；**语言选择（Rust）不变**。

## 背景

ADR-0001 选择 Node 22 + TypeScript，其三点理由都建立在**「后端是云服务」**这个前提上：
契约单源（zod 一份产出校验/类型/OpenAPI）、上游动态 JSON 归一化是主要工作、音源插件用 JS 写。

需求澄清后前提改变：后端是**桌面端本机 sidecar，不对外提供服务**——无多租户、无横向扩容、
无公网暴露、不需要独立运维与灰度。这个形态下 ADR-0001 的三点理由全部失去支点，
而它当初承认「Rust 更好」的三处（分发、音频、沙箱）反而成了主要矛盾。

## 决策

**后端改用 Rust 重做；HTTP 契约不变。** 本 ADR 取代 ADR-0001 中「运行时与语言」一节，
ADR-0001 的其余部分（分层、契约优先、降级原则、可测试性）继续有效。

| 层 | 旧（TS 骨架，已归档） | Rust 本机核心 |
|---|---|---|
| 传输 | Fastify 5（HTTP，已被 ADR-0003 取消） | **Tauri IPC：命令 + 事件**（无 HTTP、无端口、无 CORS） |
| 契约类型给前端 | zod → TS 直接可用 | **specta / tauri-specta** 从 Rust 结构体生成 TS 绑定 |
| 校验 | zod schema + provider | serde 反序列化即校验 + 显式业务校验规则 |
| 数据库 | Drizzle + pg（已取消） | SQLite：`rusqlite`（或 sqlx-sqlite）+ 迁移脚本 |
| 后台任务 | BullMQ + Redis（已取消） | tokio 任务 + 事件推进度（单进程无需队列） |
| 实时通道 | @fastify/websocket（已取消） | Tauri event |
| 日志 | pino | tracing + tracing-subscriber（按天滚动） |
| 插件运行时 | （只做声明式清单，未接入） | **内嵌 QuickJS（rquickjs）+ 能力白名单**（贡献者写 JS/TS） |

## 理由（为什么这个形态下 Rust 胜出）

1. **分发与安装**：单个十几 MB 静态二进制，对比「随安装包塞一个 Node 运行时」——后者还要
   跟着处理系统 Node 版本与安全补丁。这是 sidecar 形态下最硬的一条。
2. **进程模型**：本机后端可以直接做成 Tauri 的 in-process 命令或 `tauri::process` sidecar，
   省掉 localhost 回环与一次 IPC；`src-tauri/` 本来就是 Rust，工具链已经在仓库里。
3. **资源占用**：sidecar 与桌面端争同一台机器的 CPU/内存，常驻内存差一个量级是真实体验差异。
4. **产品主战场是音频与本地库**：扫描本地曲库、探测元数据、必要时的转码/指纹
   （symphonia / lofty / ffmpeg 绑定）在 Rust 是成熟强项，Node 侧明显弱。
5. **插件沙箱**：wasmtime 提供语言无关 + 能力可控的隔离，比 Node 侧的 isolated-vm 更干净，
   也直接满足契约里「不接受客户端传入可执行内容」的要求。
6. **契约单源的代价被抵消**：原先担心「Rust 侧要多维护一份 TS 类型」。本机形态下
   OpenAPI 就是机器可读的唯一产物，用 `openapi-typescript` 一次性生成客户端类型即可，
   不存在两头改的日常负担（云服务形态下这个负担才显著）。

## 被否决的方案

- **保持 TypeScript**（ADR-0001 现状）：代价是把 Node 运行时塞进用户机器、放弃音频与沙箱能力，
  换来的是本机形态下用不到的「生态与迭代速度」。
- **混合：TS 跑 HTTP + Rust 做重活**：本机形态下多一个进程、多一个运行时，
  还要维护两份契约映射，复杂度买不到对等收益。
- **Go**：单二进制同样满足，但音频生态与 FFI 不如 Rust，且要多引一套工具链。

## 语言无关资产（不重做）

- **41 条接口清单**（`id / method / path / tag / auth / idempotent`）：直接作为 Rust 路由与
  utoipa 注解的对照表，`test` 里「遍历清单断言无 404 / 鉴权 / 501 / 幂等」的测试思路照搬；
- **统一信封、错误码 → 状态码映射、游标分页、`Idempotency-Key` 语义、401/501 语义**：原样保留；
- **前端替换点**：客户端只认 HTTP + OpenAPI，`src/services/**` 不受实现语言影响；
- **`docs/contracts/backend-api.md`**：规范正文不变。

需要重做：`server/**` 全部代码（路由、鉴权、限流、实时、插件宿主、123 项测试），
以及把 zod 契约移植到 Rust 结构体并重新生成 TS 类型。

## 迁移清单（每步可验证，避免大爆炸重写）

1. 新建 Rust 核心 crate（复用 `src-tauri/` 工作区）：Tauri 命令层 + 统一信封 + 错误码映射，
   先落 `system.status` / `system.paths` 两条命令，跑通「无外部依赖也能起」；
2. 按 `docs/contracts/local-core-api.md` 的命令清单生成骨架命令（全部返回
   `common.not_implemented`），把「清单完整性 / 信封 / 未实现语义」三类守卫测试移植过去；
3. 用 `tauri-specta` 生成 TS 绑定并与 `src/api/index.ts` 逐项比对——**等价即视为迁移完成**
   （该文件此后退化为生成产物）；
4. 业务实现从 catalog / playback 起步；本机专属能力（本地库扫描、音频探测）直接落核心；
5. 前端 `src/services/**` 切到命令层，保留 mock 与本机核心的切换开关；
6. TS 版 `server/` 已归档在 `docs/archive/server-ts/`，确认无回归后可删除该目录。

## 后果与待澄清

- **端点清单需要按新形态裁剪**：不对外服务后，`auth.login/refresh/logout`（本机可免登录）、
  `skin.publish`、`plugin.install` 等市场写操作无法在本机自洽（上游注册表在别处）。
  这属于产品定位问题，**不在本 ADR 内决定**。建议先裁清单、再生成 Rust 骨架，
  否则会把一批注定无用的接口也移植一遍。若仍保留远端市场，则应明确「sidecar + 远端只读 API」两段式。
- 可测试性与降级原则（无 Postgres/Redis 也能起、探针如实报告）在 Rust 侧同样保留，
  但「内存降级」在单机场景可简化为「本地文件/SQLite」——是否引入 SQLite 见下一次决策。

## 重新评估的触发条件

- 需要多设备同步 / 账号体系 / 插件与皮肤市场服务端 → 回到双形态（Rust 本机 + 远端服务）；
- 需要服务端音频转码集群 → 仍是 Rust，无需重评；
- 分发方式改为「容器部署 + 浏览器访问」 → Node 的运行时成本消失，语言重新权衡。
