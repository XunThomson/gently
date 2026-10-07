---
status: active
last_verified: 2026-02-14
owner: gently
scope: 当前迭代状态与下一步
token_budget: 900
tldr: 第七轮：后端基础设施落地（server/ 子包：41 个端点契约 + 统一信封/鉴权/幂等/限流/实时通道/插件宿主/优雅退出，业务未实现返回 501）；server typecheck + 123 测试通过，桌面端 typecheck/build 不受影响（主包 338 KB）。
---

# STATE

## 本轮目标

构建完善**后端接口**（不含业务）并搭建**后端基础设施**：目录树、技术选型、可运行骨架。

## 已完成（第七轮）

### 1. 技术选型（`docs/adr/0001-backend-stack.md`）
Node 22 + TypeScript（与前端同语言，契约同源）· Fastify 5（插件模型契合音源宿主）·
Zod（一份 schema 同时产出校验 + 类型 + OpenAPI）· Postgres/Drizzle + Redis/BullMQ ·
jose + Argon2id · Vitest + `inject()`。单仓子包 `server/`（pnpm workspace 成员，桌面端零改动）。

### 2. 接口契约（41 个端点，全部登记且被校验/文档化）
- `server/src/contracts/endpoints.ts` 是**接口唯一目录**：`id / method / path / tag / auth / idempotent`；
  路由的 `operationId` 必须等于清单 id，`test/endpoints.test.ts` 遍历清单断言「没有任何端点 404」；
- `contracts/primitives.ts`（信封 `ApiResult` / 游标分页 / 错误码 + `ERROR_STATUS` 映射）、
  `contracts/models.ts`（Track/GroupedTrack/Album/Playlist/推荐/插件/下载/皮肤/实时事件）；
- 未实现业务统一返回 **`501 common.not_implemented`**，与 404（契约里没有该接口）语义区分；
- `/docs` 与 `openapi.json` 由路由 schema 生成（36 paths / 41 operations），**不手写文档**。

### 3. 基础设施
| 能力 | 落地 |
|---|---|
| 配置 | `config/env.ts`：Zod 校验，生产缺 `JWT_SECRET` 直接启动失败 |
| 日志 | pino：生产 JSON、开发美化、敏感字段脱敏、请求日志带 requestId |
| 错误 | `ApiError` + 全局映射（Zod → `422 invalid_argument` + `details.issues`），路由不写状态码 |
| 鉴权 | `TokenService`（HS256 access/refresh，过期码 `auth.token_expired`）+ Argon2id + 守卫（开发期虚拟主体） |
| 幂等 | `Idempotency-Key`：Redis 实现，未配 Redis 降级内存；重放返回首次结果 |
| 限流 | 按 IP + 路由，超限 `common.rate_limited` + `Retry-After`，探针不限流 |
| 实时 | `/v1/realtime` WebSocket 广播中枢（按 userId 分组、心跳、`seq` 供客户端判断漏事件） |
| 插件宿主 | 扫描 `PLUGIN_DIR` 下 `plugin.json`，Zod 校验清单 + 权限声明 + 健康状态；**仅声明式**，代码沙箱未接入（`loadEntryPoint` 明确拒绝） |
| 数据/队列 | Drizzle + pg 连接池（懒连接）、BullMQ 三个队列（download / plugin-probe / recommend-precompute） |
| 生命周期 | 优雅退出（SIGINT/SIGTERM → close → 关池，10s 兜底）、未捕获异常记录 |

降级原则：未配置外部依赖**不阻塞启动**，`/ready` 如实报告（未配置 → 200 `degraded`；已配置连不上 → 503）。

### 4. 工程
- `server/test/` 123 项：清单完整性、鉴权边界、501 语义、幂等缺键 422、探针降级、游标分页往返、
  错误映射、**信封守卫**（从 OpenAPI 反查每个 2xx/4xx 是否为统一信封，防止漏包 `resultSchema`）；
- 交付物：`server/Dockerfile`（多阶段 + 非 root + HEALTHCHECK）、`docker-compose.yml`（PG16 + Redis7）、
  `server/README.md`（目录树/命令/新增接口 5 步/降级表/已知限制）、`server/plugins/README.md`；
- 修订：修掉 `start` 脚本产物路径、去掉 fastify 弃用的 `disableRequestLogging`（改用日志级别静音）、
  补 `server/Dockerfile.dockerignore`（上下文为仓库根时生效）。

## 验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 后端类型检查 | `pnpm --filter @gently/server typecheck` | 通过（0 错误） |
| 后端测试 | `pnpm --filter @gently/server test` | 123/123 通过（4 文件） |
| 运行时（源码） | `tsx src/main.ts` | `/health` 200、`/ready` degraded、`/docs/json` 36 paths、未实现 → 501、无令牌 → 401 |
| 运行时（产物） | `node dist/src/main.js`（NODE_ENV=production） | 启动正常、JSON 日志带 reqId、生产默认强制鉴权（401）|
| 桌面端回归 | `pnpm typecheck && pnpm build` | 通过，主包 338 KB（gzip 110 KB）不变 |

## 下一步

1. **业务实现**：在 `server/src/services/**` 实现处理器，替换各 `*.routes.ts` 的 `notImplementedHandler`
   （schema 与路由声明不变）；先做 catalog/playback（打通播放链路）。
2. **数据库 schema**：`src/infra/db/schema/` 建表（users / favorites / playlists / play_history /
   plugin_configs / download_tasks / skins）并生成首个迁移。
3. **前端接入**：按 `docs/contracts/backend-api.md` §8 替换 `src/services/**`（UI/store 不动）；
   先接 catalog + playback，本地打分逻辑保留为离线兜底。
4. **插件沙箱**：worker/isolated-vm 执行 + 令牌与网络白名单，落地 `loadEntryPoint`。
5. Docker 镜像实跑（本机无 docker）、`pnpm tauri build` 窗口权限校验。

## 风险

- **Docker 未实跑**：镜像构建、HEALTHCHECK、`pnpm install --prod` 剪枝只做静态核对。
- **无 DB schema**：`db:generate` 在业务表落地前不产出迁移；接口暂不落库。
- **插件无沙箱**：只支持声明式清单，无法执行第三方代码（安全优先）。
- **OpenAPI 不含 WebSocket**：`/v1/realtime` 是升级路由，不在 `ENDPOINTS` 清单中（以 `REALTIME_PATH` 登记）。
- 桌面端仍全量 mock：推荐本地计算、三个模拟音源共用同一测试音频、本地曲目无可播地址。
- 视觉 / 交互正确性依赖浏览器人工走查（环境无法截图）。
