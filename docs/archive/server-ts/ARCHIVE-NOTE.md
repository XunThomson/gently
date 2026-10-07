# 归档：TypeScript 后端骨架（server/）

**归档原因**：该骨架按「后端是 HTTP 云服务」的假设实现（41 个端点、JWT、幂等键、游标分页、
Docker、Postgres/Redis/BullMQ）。产品定位随后澄清为**桌面端本机软件、不提供任何服务器**，
这套形态整体作废。

**仍然有效的部分**（已迁移到新契约，不要从这里照抄代码，但可参考这些设计）：
- 接口清单「唯一目录 + 遍历清单的守卫测试」这一做法；
- 统一信封与错误码 → 状态码映射的思路（新契约改为本地错误码，无 HTTP 状态码）；
- `src/infra/plugins/manifest.ts` 的插件清单字段（permissions / credentials 设计被沿用）；
- 多音源聚合与播放回退的约定（见 `docs/contracts/local-core-api.md` §4）。

**替代品**：`docs/contracts/local-core-api.md`（本机命令与事件契约）。
**不再使用**：Dockerfile / docker-compose / axum 无关，但其中的 Postgres、Redis、BullMQ、
JWT、限流、CORS、OpenAPI-over-HTTP 全部与新产品形态无关。

代码未删除仅作历史参考，不参与构建（不在 pnpm workspace、不进 tsc include、不进 Vite 依赖图）。
