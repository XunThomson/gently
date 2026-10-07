# gently server

`gently` 桌面的后端骨架：**接口契约 + 基础设施**，业务实现未接入——未实现的端点返回
`501 common.not_implemented`（不是 404，客户端据此区分「没这个接口」与「还没做」）。

技术选型与理由见 `docs/adr/0001-backend-stack.md`，接口规范见 `docs/contracts/backend-api.md`。

## 快速开始

```bash
# 1. 装依赖：pnpm workspace，在**仓库根**执行一次
pnpm install

# 2. 配置：在 server/ 内复制 .env.example 为 .env（Windows: Copy-Item .env.example .env）
cd server
cp .env.example .env

# 3. 起依赖（可选：不配 DATABASE_URL / REDIS_URL 也能启动，只是 /ready 显示 degraded）
#    本目录的 docker-compose.yml；在仓库根用 docker compose -f server/docker-compose.yml up -d
docker compose up -d

# 4. 启动（tsx watch，改代码自动重启）；仓库根等价写法：pnpm --filter @gently/server dev
pnpm dev

# 5. 看接口文档
#    http://127.0.0.1:8787/docs        （OpenAPI 自测页，由路由上的 zod schema 生成）
#    http://127.0.0.1:8787/health      （存活探针，容器 HEALTHCHECK 用它）
#    http://127.0.0.1:8787/ready       （就绪探针，报告各依赖状态）
```

开发环境下 `AUTH_REQUIRED` 缺省为 `false`（免令牌联调）；`production` 下缺省为 `true`，
且**必须**提供 ≥32 字符的 `JWT_SECRET`，否则启动即失败。

## 目录结构

```
server/
├── src/
│   ├── main.ts               进程入口：载配置 → 建 app → listen → 优雅退出（10s 兜底）
│   ├── app.ts                装配根：建 infra → 装饰 app.deps → 注册路由与错误处理
│   ├── config/               唯一配置入口（env.ts：zod 校验 + 降级开关）
│   ├── contracts/            接口契约：纯 zod，可被客户端复用（primitives / models / endpoints）
│   ├── http/                 HTTP 边界：server 装配、错误映射、统一信封、游标分页、幂等、鉴权、OpenAPI
│   │   └── routes/           按业务域拆分的路由（health / auth / catalog / library / recommend /
│   │                         playback / plugin / download / skin / realtime）
│   └── infra/                外部依赖适配：db(Postgres/Drizzle) / cache(Redis) / queue(BullMQ) /
│                             realtime(WebSocket 广播) / plugins(音源插件宿主) / logger.ts
├── plugins/                  音源插件目录：每个子目录一个 plugin.json（见 plugins/README.md）
├── scripts/                  开发期脚本：export-openapi.ts 导出 openapi.json
├── test/                     vitest 用例：契约、端点清单完整性、鉴权、501、错误映射
├── Dockerfile                多阶段镜像（构建上下文是**仓库根**，见文件头注释）
├── docker-compose.yml        本地 Postgres + Redis（只起依赖，服务本身用 pnpm dev 跑）
├── drizzle.config.ts         drizzle-kit 配置（迁移输出 server/drizzle/，首次 db:generate 后生成）
├── vitest.config.ts          vitest 配置
├── .env.example              全部环境变量（含说明）
├── .dockerignore             构建忽略清单（生效范围见文件内注释）
├── Dockerfile.dockerignore   构建上下文为仓库根时真正生效的忽略清单
└── package.json / tsconfig.json
```

一句话职责：`contracts/` 定义契约，`http/` 只做 HTTP 进出，`infra/` 封装外部依赖，
`config/` 收敛配置，`app.ts` 是唯一知道具体实现的地方（测试可整体替换 `app.deps`）。

## 命令

| 命令 | 作用 | 备注 |
|---|---|---|
| `pnpm dev` | 开发运行（`tsx watch src/main.ts`） | `server/` 内执行；仓库根用 `pnpm --filter @gently/server dev` |
| `pnpm build` | `tsc -p tsconfig.json` → `dist/` | 产物入口是 `dist/src/main.js`（tsconfig 的 `rootDir` 为 `.`） |
| `pnpm start` | 运行编译产物（`node dist/src/main.js`） | 需先 `pnpm build` |
| `pnpm typecheck` | `tsc --noEmit` | 只读，不写产物 |
| `pnpm test` | `vitest run` | 遍历端点清单断言注册、鉴权、501、错误映射 |
| `pnpm db:generate` | `drizzle-kit generate` | 依据 `src/infra/db/schema/` 生成 SQL 迁移到 `drizzle/` |
| `pnpm db:migrate` | `drizzle-kit migrate` | 需要可连的 `DATABASE_URL` |
| `pnpm openapi` | `tsx scripts/export-openapi.ts` | 把运行期契约落盘为 `openapi.json`（已进 .gitignore，供前端按需生成调用代码） |

## 如何新增一个接口

1. **登记契约**：在 `src/contracts/endpoints.ts` 的 `ENDPOINTS` 里加一条
   （`id` / `method` / `path` / `tag` / `auth` / `summary` / `implemented` / `idempotent`）。
   `implemented: false` 表示契约已定、实现未接入；`test/endpoints.test.ts` 会遍历清单核对。
2. **写路由**：在对应域的 `src/http/routes/<域>.routes.ts` 里加路由，`schema.operationId`
   必须等于第 1 步的 `id`；请求参数 schema 就地声明，响应 schema 从 `contracts/models.ts` 取。
3. **挂守卫**：需要登录 → `preHandler: app.deps.requireAuth`；需要幂等（写操作）→
   `preHandler: app.deps.idempotencyGuard('<端点 id>')`，与清单里的 `idempotent: true` 对应。
   业务未实现时处理器直接用 `notImplementedHandler`（返回 501）。
4. **补模型**：新出现的 DTO 在 `src/contracts/models.ts` 补 zod schema（`contracts/` 不依赖 fastify）。
5. **验证**：`pnpm typecheck && pnpm test`；需要的话再跑 `pnpm openapi` 更新 `openapi.json`。

**schema 即文档**：`/docs` 与 `openapi.json` 都由路由上的 zod schema 生成，**不要手写 OpenAPI / JSON Schema**，
也不要在路由里自己拼状态码（业务抛 `ApiError`，状态码由 `contracts/primitives.ts` 的 `ERROR_STATUS` 决定）。

## 降级行为

外部依赖全部可选，**缺依赖不会让服务起不来**，只会降级并在 `/ready` 里如实报告：

| 情况 | 行为 |
|---|---|
| 未配置 `DATABASE_URL` | db 降级（`kind: none`），服务照常启动；需持久化的接口实现时会明确失败 |
| 未配置 `REDIS_URL` | 缓存 / 幂等键降级为内存实现（`kind: memory`），队列不启动 |
| 插件目录（`PLUGIN_DIR`，缺省 `plugins/`）不存在 | 只记一条日志，插件数 0，不影响启动 |
| `/ready`：依赖**未配置** | `200` + `status: degraded`，对应 `checks.*.status: unconfigured` |
| `/ready`：依赖**已配置但连不上** | `503`（编排系统应摘流量），对应 `checks.*.status: down` |
| `/health` | 只看进程存活，不触碰外部依赖，恒 `200` |

## Docker

```bash
# 构建（上下文必须是仓库根：需要根 pnpm-workspace.yaml / pnpm-lock.yaml）
docker build -f server/Dockerfile -t gently-server .

# 运行（生产模式必须给 JWT_SECRET，否则启动即失败）
docker run --rm -p 8787:8787 \
  -e JWT_SECRET="$(openssl rand -base64 48)" \
  -e DATABASE_URL=postgres://gently:gently@host.docker.internal:5432/gently \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -v "$PWD/server/plugins:/app/server/plugins" \
  gently-server
```

镜像里只有 `dist/`、生产 `node_modules`、`package.json`；`docker-compose.yml` 只起 Postgres / Redis，
后端服务在开发期用 `pnpm dev` 跑（见该文件里的取舍说明）。

## 已知限制（未验证项）

- **Docker 未实跑**：本机没有 docker，`Dockerfile` 的镜像构建、`HEALTHCHECK`、
  `pnpm install --prod` 的剪枝行为都只做了静态核对（`CMD` 路径已通过实际 `tsc --output` 确认）。
- **构建上下文必须是仓库根**，因此 `server/.dockerignore` 不会自动生效；
  已提供 `server/Dockerfile.dockerignore`（BuildKit 按 `<Dockerfile>.dockerignore` 查找）。
- **无数据库 schema**：`src/infra/db/schema/index.ts` 目前是空的，
  `pnpm db:generate` 在业务表落地前不会产出迁移。
- **插件只支持声明式**：`loadEntryPoint()` 直接抛错，代码沙箱未接入（安全优先，见 `plugins/README.md`）。
- **OpenAPI 不含 WebSocket 通道**：`/v1/realtime` 是升级路由，不在 `ENDPOINTS` 清单中，
  因此不进 `/docs`；它以 `REALTIME_PATH` 常量在 `contracts/endpoints.ts` 中登记。
