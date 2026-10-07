---
status: superseded
last_verified: 2026-02-14
owner: gently
scope: 后端技术选型与目录结构决策（已作废）
token_budget: 1200
tldr: 【已作废】若后端是云服务，则 Node 22 + Fastify 5 + Zod + Postgres/Drizzle + Redis/BullMQ 是合理选择。但产品定位为「桌面端、不提供服务器」后，该形态整体取消：语言部分见 ADR-0002（改 Rust），形态部分见 ADR-0003（改本机核心 + Tauri IPC）。
---

# ADR 0001：后端技术选型与仓库结构

> ⚠️ **本 ADR 已作废，仅作历史参考。**
> - 语言选择（Node 22 + TypeScript）：被 `docs/adr/0002-backend-language.md` 取代（改 Rust）；
> - 整体形态（HTTP 服务 / 数据库 / 缓存 / 队列 / 容器）：被 `docs/adr/0003-no-server-local-core.md`
>   取代（产品不提供服务器，改为 Rust 本机核心 + Tauri IPC）；
> - 实现骨架已归档到 `docs/archive/server-ts/`，HTTP 规范归档到
>   `docs/archive/contracts/backend-api-http.md`。
>
> 仍然被沿用的思路（已迁入新契约）：分层与依赖方向、契约优先、优雅降级、可测试性、
> 「清单唯一目录 + 遍历清单的守卫测试」、统一信封与错误码映射、插件清单的 permissions/credentials 设计。

## 背景

桌面端（Tauri + React）已完成 UI 与 mock 数据链路，接口契约已在
`src/api/contract.ts` + `docs/contracts/backend-api.md` 定义。
现在需要落地后端**基础设施**（不含业务实现）：目录树、技术栈、可运行骨架、
每个端点存在且被校验/文档化（未实现返回 501）。

## 决策

### 1. 运行时与语言：Node.js 22 + TypeScript

- 与桌面端同语言，`src/api` 的契约类型可直接复用（结构对齐即可，不需要代码生成）；
- 团队已有 TS 工具链（tsc / Vite），上手成本最低；
- Node 22 为 LTS，原生 `fetch`/`WebSocket`/`node:test` 齐备。

**被否决**：Go / Rust（性能与部署更好，但要维护两套类型定义，且当前瓶颈在音源上游而非服务端）；
Python（生态好但类型契约会分叉）。

### 2. Web 框架：Fastify 5

- 插件（encapsulation）模型天然契合「音源插件宿主」；
- JSON Schema 一等公民 → 与 Zod 组合即可自动产出 OpenAPI；
- 内置 pino 日志、成熟生态（cors/helmet/rate-limit/websocket/swagger）。

**被否决**：NestJS（DI/装饰器较重，对小团队过度设计）；Express（缺少 schema 与类型支持）；
Hono（DX 好但 Node 侧中间件生态与 WebSocket 支持不如 Fastify）。

### 3. 校验与契约：Zod 3 + fastify-type-provider-zod

一份 schema 同时产出：运行时校验 + TS 静态类型 + OpenAPI 文档。
避免「文档 / 校验 / 类型」三套定义漂移。

**被否决**：TypeBox（性能更好但可读性与团队熟悉度低）；手写 JSON Schema（三份定义）。

### 4. 数据与缓存：PostgreSQL 16 + Drizzle ORM；Redis 7 + BullMQ

- 关系型建模适合用户/收藏/歌单/插件配置；
- Drizzle 是 TS-first 的轻量 ORM，SQL 可控、迁移可读，无代码生成步骤；
- Redis 承担缓存、限流计数、幂等键，BullMQ 承担下载任务、插件健康探测、推荐预计算。

**被否决**：Prisma（代码生成与运行时较重）；MongoDB（用户数据关系性强，且需要事务）。

### 5. 鉴权：JWT（access 短 + refresh 轮换）+ Argon2id

`jose` 负责签名/校验，`argon2` 负责口令散列。
桌面端令牌存 Tauri keyring，不落 localStorage。

### 6. 测试与工具：Vitest + `fastify.inject()`；tsx 作为开发运行器

`inject()` 不需要真实网络即可覆盖路由、校验与错误映射。

### 7. 仓库结构：单仓子包 `server/`

```
gently/
├── src/                桌面端（现有）
├── server/             后端（本次新增，独立 package.json）
└── docs/contracts/     接口规范（前后端共享）
```

理由：接口契约需要与客户端同步演进；单仓便于原子提交（改契约 + 改实现 + 改客户端一起 review）。
pnpm workspace 只登记 `server`，桌面端依赖不受影响。

**被否决**：独立仓库（契约同步靠人工，小团队收益低）。

## 目录树（server/）

```
server/
├── src/
│   ├── main.ts                启动入口（配置 → 建 app → 监听 → 优雅退出）
│   ├── app.ts                 装配：基础设施 → app.deps → 路由 → 错误处理（供测试注入）
│   ├── config/env.ts          Zod 校验的环境配置（唯一配置入口）
│   ├── contracts/             接口契约（zod schema：primitives / models / endpoints）
│   ├── http/
│   │   ├── instance.ts        实例类型（ZodTypeProvider，独立文件避免循环依赖）
│   │   ├── server.ts          Fastify 实例 + 全局中间件（cors/helmet/ratelimit/websocket/docs）
│   │   ├── errors.ts          ApiError + 全局错误映射（对齐契约错误码）
│   │   ├── result.ts          ok()/fail()/notImplementedHandler（对齐 ApiResult）
│   │   ├── pagination.ts      游标分页解析/编码
│   │   ├── idempotency.ts     Idempotency-Key（Redis，未配置时内存降级）
│   │   ├── auth.ts            口令散列 + JWT 签发/校验 + 请求守卫
│   │   ├── swagger.ts         OpenAPI 文档装配
│   │   └── routes/            按域拆分的路由（health / realtime / auth / catalog / library /
│   │                          recommend / playback / plugin / download / skin）
│   ├── infra/
│   │   ├── logger.ts          pino 配置（脱敏 + 开发期美化输出）
│   │   ├── db/                drizzle + pg 连接、schema 目录、迁移入口
│   │   ├── cache/             Redis 连接与缓存 helper
│   │   ├── queue/             BullMQ 队列工厂与队列名常量
│   │   ├── realtime/          /v1/realtime WebSocket 通道与事件广播
│   │   └── plugins/           音源插件宿主（清单 schema + 注册表 + 加载器）
├── test/                      vitest：清单完整性、鉴权、501、幂等、错误映射、信封守卫
├── drizzle.config.ts
├── Dockerfile / Dockerfile.dockerignore / docker-compose.yml（本地 Postgres + Redis）
└── .env.example
```

## 分层与依赖方向

```
routes（HTTP 边界，只做校验 + 调用 service）
  ↓
services/（业务实现落地位置，本阶段尚未创建，接口处理器为 501 占位）
  ↓
infra/（db / cache / queue / realtime / plugins）
  ↓
config（环境与常量）
```

- `contracts/` 只依赖 zod，不依赖 fastify，可被客户端复用；
- 路由不允许直接触碰 infra（除 health 这类探针）。

## 后果

- 正面：接口先行、可运行、可测、可文档化；业务实现可并行补齐。
- 代价：单仓体积增大；需要保证 `server/` 不进桌面端构建（Vite/tsc 已隔离）。
- 回滚：删除 `server/` 目录与 pnpm-workspace 的一行登记即可，桌面端零影响。
