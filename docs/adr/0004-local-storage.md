---
status: accepted
last_verified: 2026-10-07
owner: gently
scope: 本机持久化：SQLite 访问层与并发模型
token_budget: 900
tldr: 单一 SQLite 文件 + rusqlite（bundled sqlite3，无系统依赖）+ 单写线程串行化写入 + WAL + 读连接池 + FTS5 全文检索 + user_version 前向迁移。选它是为「本地轻量、性能、简约」：没有服务进程、没有 async 语法糖层，热路径就是一次 C 调用；写入串行化后不存在 SQLITE_BUSY。
---

# ADR 0004：本机持久化（SQLite + rusqlite + 单写线程）

## 背景

本机核心需要持久化：收藏、歌单、播放史、本地曲目、插件状态与配置、下载任务、皮肤。
无服务器、单进程、单用户；要求**轻量、性能、简约**。候选：`rusqlite`、`sqlx-sqlite`、
纯 KV（`redb` / `sled`）、文档存储（JSON 文件）。

## 决策

**一个 SQLite 文件 + `rusqlite`（`bundled` 特性）+ 单写线程 + WAL + FTS5 + `user_version` 迁移。**

### 为什么是 rusqlite（而不是 sqlx-sqlite）

- SQLite 是**嵌入式文件数据库**：一次查询就是一次函数调用。`sqlx` 在其上再叠一层 async
  运行时与宏构建依赖，收益（编译期 SQL 校验）换不来这一层的复杂度，而热路径反而多一次调度；
- 本项目写入是**串行化**的（见下），不需要 async 连接池的并发写能力；
- `bundled` 特性把 sqlite3 源码一起编进来：**用户机器与 CI 都不需要预装 SQLite**，
  版本完全可控（避免系统库版本差异导致的 SQL 行为漂移）；
- 同步 API 放在专用线程/阻塞池上调用，边界清晰、易测（不依赖 tokio 运行时即可单测）。

**被否决**：`sqlx-sqlite`（为本地文件 DB 引入 async 与宏构建依赖，过度设计）；
`redb`/`sled`（KV 模型丢失关系查询与部分更新能力，歌单/历史/聚合都要手写索引）；
JSON 文件（无事务、无并发保护、大列表全量重写）。

### 并发模型：单写线程 + 读连接池

```
命令层（async） ──► 写队列（mpsc, 批量事务）──► 写线程（唯一持有写连接）
              └──► 读池（N 个只读连接，WAL 快照隔离）
```

- **只有一个写线程**：写入天然串行，`SQLITE_BUSY` 从设计上消失，无需重试逻辑；
- 写请求经 channel 批量合并提交（一次事务写多条），把 fsync 次数降到最低；
- 读走独立连接池：WAL 下读不阻塞写、写不阻塞读；
- 命令层 `await` 写完成（或按需 fire-and-forget + 事件通知）。

### 性能设置（开库时固定）

`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`、
`temp_store=MEMORY`、`cache_size` 按需上调；prepared statement 复用（按 SQL 缓存），
游标分页列建索引，避免 N+1（歌单曲目一次查询取回）。

**检索**：`local_tracks` 用 **FTS5**（标题/歌手/专辑）做本地全文检索，
避免 `LIKE '%x%'` 全表扫描；搜索 P95 目标 < 50ms（契约 §11 性能预算）。

**规模假设**：5 万本地曲目 + 10 万条播放史仍保持毫秒级查询；超过此量级再考虑分表或归档。

### 迁移

`user_version` + 编号 SQL（`core/store/migrations/0001_init.sql` …），**前向不可逆**：
- 启动时在单个事务内按版本号顺序应用；
- 迁移前用 rusqlite `backup` 复制一份 `gently.db.bak`，失败可回滚到备份；
- 迁移文件进版本库，任何环境可重放出相同结构。

## 后果

- 正面：零运维、零系统依赖、事务与关系查询齐备；写入无锁竞争；单测不需要外部服务。
- 代价：**单进程假设**——两个应用实例同时跑会让内存缓存与写入队列各自为政。
  对策：M0 引入单实例守卫（`tauri-plugin-single-instance`），第二个实例唤出已运行窗口；
  SQLite 层面 WAL 本身可承受多进程，但缓存一致性由单实例保证。
- 可逆性：schema 与迁移是纯 SQL，换访问层（如需 async）只影响 `core/store` 一个模块。
