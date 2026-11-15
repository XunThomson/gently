---
status: active
last_verified: 2026-11-15
owner: gently
scope: 安卓存储：数据落在哪、为什么 `Android/data` 里看不到、用户的导出出口、`content://` 直接引用的代价、导入副本的删除保护（登记表）与落地顺序
token_budget: 2100
tldr: 应用数据在 **`/data/user/0/com.xun.gently`**（私有目录，非 root 永远看不到），导入副本另在 **`<filesDir>/music`**；`Android/data` 下没有它，是因为我们从未写过外部私有目录，且 Android 11+ 不允许第三方浏览别人的 `Android/data`。**当前没有任何面向用户的导出出口**（`revealInDir` 在手机被显式禁用，FileProvider 也没覆盖 `files/`）。`content://` 只存进库会在 `library.local.scan` 第一步（`is_dir()`）就断，播放代理与封面命名同样不认它。推荐 **C（混合）**：拷贝仍是默认，「只引用」作为选项；删除保护用 SQLite 登记表，按「已登记 + 校验通过 + 曲库不引用」三条铁律删。
---

# ANDROID-STORAGE：数据在哪、能不能不拷贝、删除怎么保护

> **结论先行**：① 「数据目录在哪」→ `/data/user/0/com.xun.gently`，用户在 `Android/data` 找不到是**必然**的（§1.2）；
> 而设置页现在连路径都不显示（`data-dir-card.tsx:91-98`），是文案+能力双缺口。
> ② 「不要拷贝」→ 技术上可行（持久 URI + fd），但要同改 5 条链路且安卓侧无法 100% 保证；推荐 **C 混合**（§2.3）。
> ③ 「删除要像注册表」→ SQLite 表而非 JSON（§3.1），删除只认登记（§3.3）。**本文只给方案，不含实现；真机相关判断均标「待真机验证」。**

## 1. 数据到底在哪

### 1.1 一张表（真机路径）

| 路径 | 内容 | 谁写的 |
|---|---|---|
| `/data/user/0/com.xun.gently/` | 应用私有数据根（= 「数据目录」） | `lib.rs:197-213`（`app_data_dir()` → `paths::resolve_data_paths`） |
| ├ `gently.db`、`pet/pet.db` | 曲库/历史/下载/皮肤/订阅；宠物（独立引擎、独立库） | `paths.rs:434`、`lib.rs:246`、`:264-268` |
| ├ `cache/{media,catalog,covers}` | 播放缓存、歌词详情、**内嵌封面**（`covers.rs:5` 注释写 `<data>/covers`，实际是 `cache/covers`，`local_library.rs:136`） | `cache.rs:435`、`:379-380` |
| ├ `downloads/`、`logs/`、`plugins/`、`skins/`、`subscriptions/` | 下载成品、按天日志、插件、皮肤、订阅索引缓存 | `download.rs:203`、`lib.rs:221-227`、`paths.rs:429-433` |
| └ **`files/music/`** | **导入音频的副本**（本次反馈主角） | Kotlin `ImportPlugin.kt:201`（`activity.filesDir`） |
| `/storage/emulated/0/Android/data/com.xun.gently/…` | **空的，一个字节都没写** | — |

布局只有一份实现：`AppPaths::resolve`（`paths.rs:424-438`）。真机证据：日志里 `数据库就绪 db=/data/user/0/com.xun.gently/gently.db`、`宠物核心就绪 …/pet`（ANDROID-PLAN §1、GOTCHAS §52）。

### 1.2 为什么 `Android/data` 下看不到（两件独立的事，各占一半）

1. **我们没写外部私有目录**：Tauri 的 `app_data_dir()` 在安卓取 `Activity.getDataDir()`（Tauri 2.12.5 `mobile/android/…/PathPlugin.kt`；`lib.rs:197` 调它）→ `/data/user/0/<包名>`，`filesDir` 是同一根下的 `files/`。真正的数据在**内部存储的私有目录**，与 `Android/data`（外部存储的「应用专属目录」）是两个地方。
2. **即使它在，用户也看不到**：`/data/user/0/…` 受 Linux 权限保护，文件管理器和其它应用（含 `MANAGE_EXTERNAL_STORAGE`）都进不去，只有 root / `adb run-as`（debug 包）可读；`Android/data/<别人包名>` 从 Android 11 起被系统文件选择器屏蔽。本机 Android 10（INFRA §2 记 API 29）系统不强制，但厂商文件管理器常默认不展示——EMUI 10 具体表现**待真机验证**。

结论：用户不是找错地方，是**两处按设计都不可达**。真正的产品问题是 §1.3 的出口，不是再写一句提示。

### 1.3 用户唯一的出口：现在有没有？

| 出口 | 现状 | 依据 |
|---|---|---|
| 系统分享（`ACTION_SEND`）/ 保存到下载（MediaStore insert 或 `ACTION_CREATE_DOCUMENT`） | ❌ 都未实现；清单只有 `INTERNET`/前台服务/通知权限，**无任何存储权限** | Android 源码目录全无 `ACTION_SEND`；`AndroidManifest.xml:3-9` |
| 「在文件夹中显示」/ FileProvider | ❌ 手机上**故意禁用**；provider 在，但 `res/xml/file_paths.xml:1-5` 只声明 `external-path`+`cache-path`，**没覆盖 `files/`** → 将来拿它分享会直接 `IllegalArgumentException` | `file.service.ts:10-12`、`views/local/index.tsx:49-55`、`AndroidManifest.xml:41-49` |
| 开发取证（debug 包） | ✅ `adb shell run-as com.xun.gently ls -l files/music` | ANDROID-PLAN §1 |

**结论：当前没有任何面向用户的出口。** 用户要把歌拿出去只能靠第三方工具——这是能力缺口，不是文案问题。

## 2. 「不拷贝、直接引用」的技术评估

### 2.1 五条链路：现状 + 改成 `content://` 要付的代价

| 链路 | 现状（依据） | 改成引用要做什么 | 风险 |
|---|---|---|---|
| 扫描/入库 | 根必须 `is_dir()` + `WalkDir`；id = `local:<规范化路径>`；`path` 列 `UNIQUE`（`local_library.rs:290-301`、`:332`；`0005_local_tracks.sql:12`） | 加「按 URI 入库」入口；库里区分 locator 种类 | **最大**：id/路径是全仓假设（封面、代理、删除、导出） |
| 标签/时长/封面 | `std::fs::File::open` + symphonia（`local_library.rs:390-404`） | 按 locator 打开；封面名从「路径哈希」改「locator 哈希」（`covers.rs:47-57`） | 中：要能 seek；旧封面失效（可重建） |
| 播放 | `local:<path>` → `publish_local`：**必须音频扩展名 + `is_file()`**，代理按 `Range` 读盘（`commands.rs:1388-1401`、`media.rs:170-183`） | `StreamTarget` 加 fd 目标；校验换成「locator 可播」 | 中：fd 生命周期；`Range` 取决于 provider |
| 删除 | `std::fs::remove_file`（`local_library.rs:249-271`） | 引用模式**不删原文件**，只释放授权 | 中：两种语义必须两个命令名 |
| 导入 | 只拷文件，不解析授权（`ImportPlugin.kt:58-68`、`:140-156`） | 取回后 `takePersistableUriPermission`；返回 per-file 元数据 | 中：持久授权有系统上限（数值**待真机验证**） |

注意：SAF 现在是**临时授权**，只有选**目录**那条路申请了持久化（`ImportPlugin.kt:125-130`、`:167-174`）——授权层也还没准备好。实现要点（避免走成「逐块过 JNI」）：`openFileDescriptor(uri,"r")` → `detachFd()` → fd 交给 Rust，代理/标签/封面全按 fd 读写（`File::from_raw_fd` 可 `seek`，`Range` 照常），JNI 只在「解析授权」这一步；`is_audio_path` 要看 `OpenableColumns.DISPLAY_NAME` 而不是 URI 字符串（与 R118 的 `isAudioName` 同一份名单，`ImportPlugin.kt:328-332`）。

### 2.2 「只把 URI 存进库」在哪一步断——四处同时断

1. **入库即失败**：`library.local.scan` 对每个 `dirs[i]` 做 `is_dir()`，`content://` → `false` → `common.invalid_argument`「不是目录」（`local_library.rs:290-301`）。
2. **绕过扫描写进 `path` 也不行**：`playback.resolve` 把 `local:<URI>` 交给 `publish_local`，`Path::extension()` 为空 → `is_audio_path` false → `media.blocked_address`（`media.rs:171-177`）；再过一关还有 `is_file()` → `not_found`（`:178-181`）。
3. **封面永远查不到**：`cover_url`/`file_name` 按路径哈希（`media.rs:127-140`、`covers.rs:47-57`）。
4. **删除会「假成功」**：`remove_file(content://…)` 报 `NotFound`，而这里把它当「文件已不在，照常删库」（`local_library.rs:261-262`）→ 用户以为删了，文件还在。**最该先堵的雷。**

### 2.3 方案对比与推荐

| 方案 | 做法 | 代价 | 风险 |
|---|---|---|---|
| **A 保持拷贝 + 清理入口**（现状） | 拷进 `files/music`；R119「清理副本」腾空间 | 0（已落地） | 双份：导入 1.3 GB 就额外再占 1.3 GB（R136 真机量级） |
| **B 持久 URI 引用** | 持久授权 + fd + 库内 locator，五链全改 | **大**：核心 + Kotlin + DB 迁移 + 全部读点 | provider 差异（云盘常不支持随机读）、授权被回收/来源卸载 → 整首不可播；只能真机验 |
| **C 混合（推荐）** | 导入时让用户选「导入副本 / 只引用」；引用走 B 的 locator，副本走 A + 登记表 | A ∪ B | 两条都要测；但 B 失效时用户能退回 A |

**推荐 C，三条理由**：① 用户诉求是「别存两份」，但安卓上「引用」**不可能 100% 可靠**（授权失效、provider 不支持随机访问），纯 B 失效就是「库里有歌、点了放不出」，比多占空间坏得多；② 拷贝这条路已有 R114/R118/R136/R119 四条真机验收（1.3 GB、`m4s`、清理），是资产，不该拆；③ C 的增量不是两套代码而是**一个 locator 抽象**——A 只是 locator 的一种（私有路径 + 登记行），先落登记表（§3）再让 locator 支持 `content`，天然复用。若 B 真机上大面积失效，折中是 **C′：引用 + 首次播放按需落 `cache/media`**（复用 `commands.rs:1357-1384` 的缓存命中路径），代价是被淘汰后要重新拷。

## 3. 删除保护：已导入副本登记表（像注册表，但用 SQLite）

### 3.1 为什么是 SQLite 表而不是 JSON 注册表

| 理由 | 具体 |
|---|---|
| **事务 + 崩溃一致性** | 「登记 ↔ 入库 ↔ 移库 ↔ 删文件」要同进同退（先例：`store/local.rs:70-114` 批量 upsert）；JSON 要么整文件重写（写一半全丢），要么自造临时文件+fsync 协议，而 WAL 的成本已经付过 |
| **与曲库同库** | 备份/迁移只认 `*.db`：`system.dataDir.move` 拷完还会 `PRAGMA quick_check` 自检（`paths.rs:272-283`），JSON 不在保护里 |
| **查询 + 单写者** | 「是否仍被曲库引用」要 JOIN `local_tracks`（JSON 得在内存里算）；一个安装只有核心持连接，JSON 那种「谁都能改」是负担不是自由 |

### 3.2 表结构（迁移 `0009_imported_files`，只追加）

```sql
CREATE TABLE IF NOT EXISTS imported_files (
  id TEXT PRIMARY KEY,               -- 'imp:<uuid>'（不用路径当主键：路径可被改）
  uri TEXT NOT NULL DEFAULT '',      -- content:// 原文；副本模式可空
  provider TEXT NOT NULL DEFAULT '', -- uri.authority（能拿到的「来源提供方」）
  document_id TEXT NOT NULL DEFAULT '',
  target_path TEXT NOT NULL UNIQUE,  -- 副本落点，先过 normalize_source_path
  bytes INTEGER NOT NULL,  mtime_ms INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL DEFAULT '',     -- sha256 hex；'' = 未算
  display_name TEXT NOT NULL DEFAULT '',  imported_at INTEGER NOT NULL,
  registered_by TEXT NOT NULL DEFAULT 'copy',   -- copy | adopt（老副本回填）
  state TEXT NOT NULL DEFAULT 'pending',        -- pending | present | missing | deleted
  last_verified_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS imported_files_state ON imported_files (state);
```

取舍：**「是否仍被曲库引用」不存列**，用派生查询 `EXISTS (SELECT 1 FROM local_tracks WHERE path = target_path)`——存成列就是两份真相；`target_path` 走与 id/封面同一份归一化（`paths.rs:382-402`）；`uri`/`document_id`/`provider` 在副本与 `adopt` 回填时可空，引用模式必须有。

### 3.3 删除流程（五条铁律）

1. **只删登记内**：`state='present'` 的行；`files/music` 下**没登记的文件一律不动**，只列出来。
2. **只删根目录内**：`target_path` 必须落在宿主 `imported_dir` 之内（`ImportPlugin.kt:84-88`，前端不猜）。
3. **校验不过就不删**：`bytes`/`mtime_ms` 不符 → `mismatch` 拒绝（严格模式再比 `hash`）。**失效时降级为「不删」，不是「照删」。**
4. **曲库还在用就不删**：先 `library.local.remove` 移库，再删文件（顺序不能反）。
5. **正在播先停**：现有 `purgeImported` 已这么做（`library.slice.ts:105-120`）。

状态机：`register` 写 `pending` → 文件在且 size 对 → `present` → 文件消失 → `missing`；删成功 → `deleted`（软删留审计，不物理删行）。启动路径上**不做**全盘对账（几十 GB 的 stat 会拖慢冷启动），由 `list`/`purge` 前触发的 `verify` 完成。

### 3.4 命令清单（契约级，只写形状）

| 命令 | 入参 | 出参 | 说明 |
|---|---|---|---|
| `library.import.register` | `{entries:[{path, bytes, mtimeMs, uri?, provider?, documentId?, displayName}]}` | `{registered, duplicated}` | 单事务 upsert；重复 path 幂等 |
| `library.import.list` | `{limit?, cursor?, state?}` | `{items:[…, inLibrary, bytes], total, totalBytes}` | 取代前端 `importedTracksOf` 的**前缀猜法**（`importNote.ts:72-76`） |
| `library.import.verify` | `{ids?, mode?: 'stat'\|'hash'}` | `{checked, missing, mismatched}` | 只报告，不删 |
| `library.import.purge` | `{ids?, dryRun?}` | `{deleted, freedBytes, skipped:[{id,reason}]}` | `reason` ∈ `notRegistered/referenced/outsideRoot/mismatch/missing/playerBusy`；**`dryRun` 必须先能用**（先让用户看会删什么） |
| `library.import.release` | `{ids}` | `{released}` | 引用模式：只释放 SAF 授权，**不删原文件** |
| `library.import.adopt` | `{dir}` | `{adopted}` | 迁移期把 `files/music` 下**已入库**的老副本回填为 `registered_by='adopt'` |

宿主命令 `imported_dir`/`import_progress` 不变（`contracts/local-core-api.md:332-333`）。新增命令按 AGENTS #13 走全套：契约文档 + `src/api/index.ts` + `services/` 封装 + `check:contract`/`check:reachability`，且必须有界面入口。

### 3.5 hash 成本与 `(size, mtime)` 折中

SHA-256 对 1.3 GB 在手机上是**秒**级不是毫秒级（具体**待真机实测**）；对 1 万首小文件逐个算则是分钟级。分层：登记只记 `size+mtime`（一次 `stat`）→ 清理默认按 `(size,mtime)` 校验 → `hash` 只在 `verify{mode:'hash'}` 或「严格清理」时算，可后台补算、不进导入热路径。为什么敢用 `(size,mtime)`：文件是我们自己写进 `files/` 的（内部存储，不是 FUSE 模拟的 `/sdcard`），外部改动非常规；而**误删不可逆**——所以校验不过时是「不删」。也因此不能拿 SAF 的 `LAST_MODIFIED` 当依据（`OpenableColumns` 这列常缺失，具体 provider **待真机确认**）。

### 3.6 迁移与回滚

- **迁移**：追加 `0009_imported_files`（不 ALTER 历史表），`user_version` 8→9（`migrations.rs:13-26`、`:29-48` 每迁移一事务）。**老副本不回填也可用**：清单为空 → 一条不删、界面不显示清理（安全默认）；要恢复 R119 的清理能力就调一次 `library.import.adopt{dir}`（`dir` 由宿主 `imported_dir` 给，核心不知道 `filesDir`）。
- **回滚**：先摘 UI 入口、命令降级为只读，**不 DROP TABLE**（丢登记 = 回到「猜路径」）；旧版本读到多出来的表无害；`user_version` 不回退（ADR-0004 前向不可逆）。验收：`cargo test -p gently-core`（迁移）+ 真机 `run-as` 查表（§4 命令）。

## 4. 可执行落地顺序

**P0（低风险，直接回答用户 #1；本轮只交文档、不动代码）**

| 事项 | 怎么验 |
|---|---|
| 设置页数据目录卡片手机形态**显示真实路径**（`system.dataDir.current` / `system.paths()` 已在契约里）+ 「复制」（`utils/clipboard.ts` 的 `copyText`） | 真机 `node scripts/android-cdp.mjs eval "document.body.innerText.includes('/data/user/0/com.xun.gently')"` → `true`；浅/深色各一张截图 |
| 文案说清「文件管理器看不到这里是 Android 的设计」并指向 §1.3 出口（zh/en 同日改）；导入副本那行补**占用大小**（现有 `importedCopies` 只有条数，`ScanPanel.tsx:219-235`） | 截图 + 中英文案核对；手机形态不出现桌面才有的「打开目录」；纯函数求和 + smoke 断言，真机数字与 `run-as du -sh files/music` 同量级 |

**P1（登记表 + 真出口，用户 #3 的正解）**

1. Kotlin 导入返回 per-file 元数据 → `library.import.register`，导入后 `list` 立刻能列（`pending→present`）；同时 `list/verify/purge/adopt` + 前端把 `importedTracksOf` 前缀匹配换成 `list`（不再「只靠路径猜」）。
2. 出口：「保存到下载」用 `ACTION_CREATE_DOCUMENT` 批量导出或 MediaStore 写入公共音乐库；分享单曲先给 `file_paths.xml` 补 `files-path name="music" path="music/"`（`res/xml/file_paths.xml:1-5`）。
3. 每步都跑，预期：`purge` 后 `files/music` 只剩**没登记**的文件、正在播的待删曲目被先停；导出文件出现在系统「下载/音乐」并能被第三方播放器打开（**待真机验证**：API 29 上 MediaStore 自建条目是否无需权限）。

```powershell
$adb = "$env:ANDROID_HOME\platform-tools\adb.exe"
& $adb shell run-as com.xun.gently sh -c 'ls -l files/music; du -sh files/music; ls -l cache/covers'
```

**P2（引用模式，用户 #2 的正解）**

1. 先只改**播放**一条链路（fd + `StreamTarget`）：引用曲目可放可拖；标签/封面暂退回文件名/渐变。
2. 再补标签/封面与 `needsRegrant` 状态（授权失效必须有明确 UI，不能静默变「无法播放」）；真机长测：冷启动后能播、删掉源文件/来源应用卸载后给明确错误、持久授权上限行为。

## 5. 未决问题

1. 本机 EMUI 10 / API 29 上哪些 provider 支持可 seek 的 fd（云盘类 `openFileDescriptor` 可能抛异常），以及持久授权的数量上限与超限行为——两者一起决定「引用」能否规模化；**待真机验证**。
2. 系统低存储时清理 `cacheDir` 是否连带清掉 `cache/covers`（`<data>/cache` 与 `Activity.cacheDir` **是同一目录**）→ 要不要把播放缓存移出 `cache/`？**待真机验证** + 产品决定。
3. 「来源应用」能拿到什么：SAF 只给 `uri.authority`（**提供方**，如系统 MediaStore），拿不到「哪个 App 分享的」——`provider` 的措辞要不要改。
4. 引用模式下要不要允许**删原文件**（`DocumentsContract.deleteDocument`）——破坏性，需产品决策。
5. R121 曾决定「手机不显示路径」（`ANDROID-PLAN.md:386`），与本次反馈 #1 直接冲突：只恢复只读显示，还是加一张「存储占用」卡？
6. 同一首歌先「拷贝」又被「引用」时怎么合并（`target_path UNIQUE` + 两条 locator 是否允许）。
7. `hash` 严格模式默认开还是关（安全 vs 导入 1.3 GB 的等待）。

## 6. 证据与相关文档

- 依据与现状：[`ANDROID-INFRA-ASSESSMENT.md`](ANDROID-INFRA-ASSESSMENT.md) §3.5；[`ANDROID-PLAN.md`](ANDROID-PLAN.md) §7.3（R114/R118/R119/R130/R136）、§8（「音乐目录导出仍挂着」）；[`GOTCHAS.md`](GOTCHAS.md) §52；[`contracts/local-core-api.md`](contracts/local-core-api.md)。关键实现：`core/src/local_library.rs`、`media.rs`、`covers.rs`、`paths.rs`；`src-tauri/src/importer.rs`；`ImportPlugin.kt`；`src/utils/importNote.ts`、`src/store/slices/library.slice.ts`。
