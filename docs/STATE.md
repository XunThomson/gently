---
status: active
last_verified: 2026-10-07
owner: gently
scope: 当前迭代状态与下一步
token_budget: 950
tldr: 第八轮：产品定位澄清为「桌面端、无服务器」——取消 HTTP 后端形态，TS 骨架与旧 HTTP 契约归档，契约重写为本机核心命令/事件清单（约 45 命令 + 4 类事件），新增 ADR-0003 并修订 ADR-0002 的传输层；typecheck / smoke(172) 全绿。
---

# STATE

## 本轮目标

按澄清后的产品定位重整后端形态与契约：不提供服务器、不需要账户服务、桌面端无 web 端、
社区资源（插件/皮肤）靠用户自行 clone / 下载 / 分享后**通用导入**。

## 已完成（第八轮）

### 1. 定位与决策
- 三条约束：**不提供服务器**（无账号、无市场后端、无遥测）；将来同步歌单是**用户自己的第三方账号**
  （凭据存本机 keyring，不经我方服务）；**桌面端无 web 端**。
- 新增 `docs/adr/0003-no-server-local-core.md`：取消 HTTP 服务形态，改为「Rust 本机核心 + Tauri IPC」。
  ADR-0001 整体作废；ADR-0002 保留语言选择（Rust），传输层由 axum/HTTP 修订为命令/事件 + specta 绑定。
- 分发机制定为**通用导入**（本地目录 / 压缩包 / URL / 粘贴文本四合一 `ImportSource`）：
  社区仓库由用户自行 clone 后指向目录，**应用不内建 git 客户端**（不要求用户装 git）。

### 2. 契约重写（`docs/contracts/local-core-api.md` + `src/api/index.ts`）
- **约 45 条命令**（system / catalog / library / recommend / playback / plugin / download / skin）
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

## 验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | 通过（契约重写后 0 错误） |
| 冒烟测试 | `pnpm smoke` | 172/172 通过 |
| 残留引用 | 搜 `@gently/server` / `server/src` | 0（配置、锁文件、文档均已清理） |
| 消费方影响 | 全仓搜 `src/api` 导入 | 0——契约是纯类型，UI/store/services 未被波及 |

## 下一步

1. **Rust 核心骨架**（按 ADR-0002 迁移清单）：Tauri 命令层 + 信封/错误码 + `system.status` /
   `system.paths`，其余命令先返回 `common.not_implemented` 并移植三类守卫测试；
2. `tauri-specta` 生成 TS 绑定，与 `src/api/index.ts` 逐项比对——**等价即视为迁移完成**；
3. **插件宿主**：QuickJS 运行时 + 权限白名单（受限 fetch）+ `preview`/`import` 同意流程；
4. **本机库**：SQLite schema（favorites / playlists / play_history / local_tracks / plugin_state /
   download_tasks / skins）+ 目录扫描与音频元数据探测；
5. **前端接入**：`src/services/**` 换成命令层调用，先做 catalog + playback，保留 mock 开关。

## 风险

- **命令清单仍需逐条确认落地**：`auth.*` 已删、市场写操作改为导入/导出，其余命令待 Rust 侧核对；
- **社区插件是不可信代码**：沙箱与安装期同意是硬要求——不做就等于让用户执行陌生代码；
- **无遥测**：线上问题只能靠本地诊断页与用户主动提供的日志；
- 皮肤令牌键名白名单目前只有契约，尚无实现；
- 视觉 / 交互正确性仍依赖人工走查（环境无法截图）。
