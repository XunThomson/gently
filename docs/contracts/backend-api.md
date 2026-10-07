---
status: active
last_verified: 2026-02-14
owner: gently
scope: 后端 HTTP / 实时接口规范（契约，无实现）
token_budget: 2600
tldr: 统一信封 + 游标分页 + 幂等写 + 多音源回退由后端承担；8 个域的能力接口定义在 src/api/contract.ts，前端只需替换 services 层。
---

# 后端接口规范

> **本文件是规范，不是实现。** 类型契约在 `src/api/types.ts` 与 `src/api/contract.ts`。
> 当前前端以 mock 运行（`src/services/**`），接入时只替换 services 内部的调用，UI / store 不变。

## 1. 基本约定

| 项 | 约定 |
|---|---|
| 协议 | HTTPS（桌面端可用 HTTP，但需显式配置） |
| 版本 | 路径版本 `/v1/...`；破坏性变更升 `/v2`，旧版本至少保留两个大版本 |
| 编码 | 请求与响应均为 `application/json; charset=utf-8` |
| 命名 | 路径 `kebab-case`，字段 `camelCase` |
| 时间 | ISO 8601 带时区（`2026-02-14T10:00:00+08:00`） |
| 幂等 | 所有写接口需带 `Idempotency-Key` 请求头（值建议 UUID v4） |
| 超时 | 客户端默认 15s；批量/导出类接口允许 60s |

## 2. 统一信封

**成功**

```json
{ "data": { }, "requestId": "req_01H..." }
```

**失败**（HTTP 4xx/5xx，body 仍为 JSON）

```json
{
  "error": { "code": "source.upstream_failed", "message": "bilibili upstream timeout", "details": { "source": "bilibili" } },
  "requestId": "req_01H..."
}
```

约定：

- 客户端**不依赖 HTTP 状态码分支**，只读 `error.code`；状态码仅用于网关/日志；
- `requestId` 必须回传，便于前后端联合排查；
- `message` 面向开发者，不直接展示给用户；用户可见文案由前端 i18n 决定。

### 错误码

| code | 含义 | 客户端建议 |
|---|---|---|
| `auth.unauthorized` | 未登录 | 跳登录 |
| `auth.token_expired` | 令牌过期 | 静默 refresh，失败则跳登录 |
| `auth.forbidden` | 无权限（版权/会员） | 提示并保留 UI |
| `common.not_found` | 资源不存在 | 空态 |
| `common.invalid_argument` | 参数校验失败 | 展示 `details` |
| `common.rate_limited` | 触发限流 | 按 `Retry-After` 退避 |
| `source.upstream_failed` | 上游音源失败 | **不要**提示用户，切换音源 |
| `common.upgrade_required` | 客户端版本过低 | 强制升级提示 |

## 3. 分页

一律**游标分页**（不用 offset，避免翻页时数据漂移）：

```
GET /v1/search?keyword=晚风&limit=30&cursor=eyJpZCI6...
→ { "data": { "items": [...], "nextCursor": "eyJpZCI6...", "hasMore": true } }
```

`limit` 上限 200，默认 30；`nextCursor` 缺失表示末页。

## 4. 认证

- `POST /v1/auth/login` → `accessToken`（默认 2h）+ `refreshToken`（默认 30d）；
- 刷新：`POST /v1/auth/refresh`，客户端在收到 `auth.token_expired` 时静默重试一次；
- 桌面端令牌存本地安全存储（Tauri keyring），**不写 localStorage**；
- 登出：`POST /v1/auth/logout`，服务端使 refreshToken 失效。

## 5. 多音源策略（与前端对齐的关键约定）

前端已实现「聚合展示 + 播放期回退 + 手动切换」，后端需承担同样的语义：

1. **搜索/推荐**：后端负责**跨源去重**（同一首歌合并为一条），并在响应里带上候选音源；
   前端会在候选间做自动回退，因此**候选顺序即优先级**，后端需按用户偏好排序。
2. **播放地址**：`POST /v1/playback/resolve` 由后端按 `preferredSource` + `quality` 依次尝试；
   全部失败时返回 **`data: null`**（而不是错误），前端据此退回本地模拟时钟。
3. **音质降级**：源不支持期望音质时返回实际下发的 `quality`，前端据此显示真实档位。
4. **健康探测**：源不可用时通过 `plugin.health` 实时事件推送，前端据此标记「不可用」。

## 6. 端点清单

见 `src/api/contract.ts` 的类型定义，摘要如下：

| 域 | 端点 | 说明 |
|---|---|---|
| auth | `POST /v1/auth/login` `POST /v1/auth/refresh` `POST /v1/auth/logout` `GET /v1/auth/profile` | 登录与令牌 |
| catalog | `GET /v1/search` `GET /v1/charts` `GET /v1/tracks/{ref}` `GET /v1/albums/{id}` `GET /v1/curated/{id}` `GET /v1/lyrics` | 曲库检索与歌词 |
| library | `GET /v1/me/favorites` `POST /v1/me/favorites/sync` `GET/POST/DELETE /v1/me/playlists` `POST /v1/me/history` `GET /v1/me/history` | 用户数据同步（幂等） |
| recommend | `GET /v1/recommend/home` `GET /v1/recommend/similar` `POST /v1/recommend/feedback` | 个性化推荐 |
| playback | `POST /v1/playback/resolve` `POST /v1/playback/report` | 播放地址与播放上报 |
| plugin | `GET /v1/plugins` `POST /v1/plugins/install` `POST /v1/plugins/uninstall` `POST /v1/plugins/check-updates` `GET/POST /v1/plugins/{id}/config` | 音源插件市场 |
| download | `GET /v1/downloads` `POST /v1/downloads` `POST /v1/downloads/{id}/pause|resume` `DELETE /v1/downloads/{id}` `POST /v1/downloads/clear-finished` | 下载管理 |
| skin | `GET /v1/skins` `GET /v1/skins/{id}` `POST /v1/skins` `GET /v1/me/skins` `POST /v1/me/skins/sync` | 皮肤市场与同步 |

### 实现状态（与 `server/` 的对应关系）

后端骨架已按本规范落地：接口清单在 `server/src/contracts/endpoints.ts`，
每个端点都有请求/响应 schema 与自动生成的 OpenAPI（`http://<host>/docs`），
**业务实现尚未接入**——所以未实现端点返回 `501 common.not_implemented` 而非 404。

- 404 = 契约里没有这个接口；501 = 契约已定、实现待接（前端在联调期据此区分）；
- 接入业务时：把对应 `server/src/http/routes/*.routes.ts` 中的 `notImplementedHandler`
  换成真实处理器即可，schema 与路由声明不变；
- 技术选型与目录约定见 `docs/adr/0001-backend-stack.md` 与 `server/README.md`。

## 7. 实时通道

`wss://<host>/v1/realtime`，事件体与 REST DTO 共用（`RealtimeEvent`）：

| 事件 | 触发 | 前端动作 |
|---|---|---|
| `download.progress` / `download.done` | 下载进度 | 更新下载切片 |
| `plugin.health` | 源健康变化 | 标记音源可用性、触发回退 |
| `session.revoked` | 令牌失效/异地登录 | 登出并提示 |

客户端需支持断线重连（指数退避，上限 30s）与 `Last-Event-Id` 续传。

## 8. 前端替换映射（接入时的唯一改动点）

| 前端位置 | 现在（mock） | 接入后 |
|---|---|---|
| `services/catalog.service.ts` | 内置模拟音源 | `api.catalog.*` + `api.playback.resolve` |
| `services/library.service.ts` | `mock/*` 常量 | `api.library.*` |
| `services/recommend.service.ts` | 本地画像打分 | `api.recommend.home`（本地打分逻辑保留为离线兜底） |
| `services/audio.service.ts` | 内置测试音频 | 播放 `api.playback.resolve` 返回的 URL |
| `store/slices/plugin.slice.ts` | 注册表 | `api.plugin.*` + 本地启用状态缓存 |
| `store/slices/download.slice.ts` | mock 推进 | `api.download.*` + 实时事件 |
| `store/slices/ui.slice.ts`（皮肤） | localStorage | `api.skin.*`（本地保留离线副本） |

## 9. 非功能性要求

- **限流**：按用户 + 端点限流，超限返回 `common.rate_limited` 与 `Retry-After`；
- **缓存**：`GET` 类接口支持 `ETag` / `If-None-Match`；榜单与推荐建议 60s 边缘缓存；
- **可观测**：响应必带 `requestId`，服务端日志与该 id 关联；
- **兼容**：新增字段不得改变已有字段语义；删除字段需先标记 deprecated 一个小版本；
- **安全**：不接受客户端传入的可执行内容（插件以清单 + 服务端签名方式下发）。
