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

计划与退出标准见 **`docs/ROADMAP.md`**（M0 骨架与契约 → M1 插件宿主 → M2 播放链路 →
M3 本机库与持久化 → M4 推荐与皮肤 → M5 收口交付）。要点：

| 项 | 结论 |
|---|---|
| Cargo 结构 | workspace：`core`（不依赖 tauri，可独立 `cargo test`）+ `src-tauri`（薄适配层） |
| 存储 | rusqlite（bundled）+ 单写线程 + WAL + FTS5 + `user_version` 迁移（`docs/adr/0004-local-storage.md`） |
| 职责边界 | **前端只做 UI 与渲染；数据处理与算法（含推荐打分）归 core**；同一算法只允许一份实现 |
| 首个插件 | demo 插件（移植现有 mock 源）+ 故意越权的测试插件 |

顺序与退出标准：

1. **M0 骨架与契约**：Cargo workspace、信封/错误码/tracing、`system.*` 真实现、其余命令返回
   `common.not_implemented`；`specta` 生成绑定 + `check-commands` 文档↔注册表一致性守卫；
2. **M1 插件宿主**（最大不确定项）：QuickJS 沙箱 + 清单校验 + `hosts` 白名单 + 四种导入来源
   + `preview`/同意/`import` + keyring 凭据；
3. **M2 播放链路**：catalog 聚合去重排序 + `playback.resolve` 回退链，前端 catalog/audio 切命令层；
4. **M3 本机库与持久化**（可与 M1/M2 并行）：SQLite 表与迁移、收藏/歌单/历史、本地扫描 + FTS5、
   下载任务与事件；
5. **M4 推荐与皮肤**：推荐画像与打分**迁入 `core/recommend`**（同夹具对比后删除 TS 实现，
   mock 改预置数据）；皮肤令牌白名单校验与导入导出；
6. **M5 收口**：诊断页、错误码→zh/en 文案、`pnpm verify` 一条命令、`pnpm tauri build` 实测出包。

## 风险

- **命令清单仍需逐条确认落地**：`auth.*` 已删、市场写操作改为导入/导出，其余命令待 Rust 侧核对；
- **社区插件是不可信代码**：沙箱与安装期同意是硬要求——不做就等于让用户执行陌生代码；
- **无遥测**：线上问题只能靠本地诊断页与用户主动提供的日志；
- 皮肤令牌键名白名单目前只有契约，尚无实现；推荐算法的 Rust 迁移需防行为漂移（见 ROADMAP §6）；
- **单实例假设**：SQLite 单写线程 + 内存缓存要求单实例，M0 需引入单实例守卫；
- 视觉 / 交互正确性仍依赖人工走查（环境无法截图）。
