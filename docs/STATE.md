---
status: active
last_verified: 2026-10-18
owner: gently
scope: 当前迭代状态与下一步
token_budget: 950
tldr: 第六十四轮（R64）：**桌面歌词锁定（点击穿透）**。① 设置页新增「桌面歌词」卡片（不锁定 / 锁定），锁定后 `setIgnoreCursorEvents(true)`，点击穿透到下面的窗口；解锁只能在设置页——锁定后歌词窗口自己收不到任何点击（含它自己的 ×），把解锁放在它身上等于死锁。② 状态持久化在 localStorage，**每次显示都重新同步一遍**（true/false 都写）：窗口 API 失败时查不到真实状态，靠下次显示自愈，避免「锁上之后解不开」。③ 顺带把开关改成**先切界面再落盘**（之前 `await` 后才 setState，写失败会让点击看起来无效）。`pnpm smoke` **360/360**（+3）；契约 70 命令 / 9 事件 / 26 错误码、可达性 164/72/145、核心 241/241 全绿。打包版实测：锁定后点歌词条自己的 × → **窗口没有关闭**（点击穿透生效），重启后设置页仍是「锁定」。**未验证**：解锁方向（点「不锁定」后 × 恢复可点）因驱动命中点不稳定没能实测通过，如实登记。此前第六十三轮（R63）：**桌面歌词记住位置**（待完成项 4 的第一条）。① 显示时用用户上次拖动后的坐标（关窗口/关开关时先把真实坐标存进 localStorage），不再每次回到底部居中。② 判断逻辑抽成纯函数 `utils/lyricsWindowPosition.ts`：至少一半面积落在某块屏幕里才用，否则回退底部居中；可用但半出屏的会被夹回屏幕内。③ 顺手发现第一版**一直在静默降级**：`currentMonitor()` 被窗口 ACL 拒绝、异常被 catch，所以「摆到底部居中」其实从未生效——补上 `allow-outer-position` / `allow-available-monitors` 两个权限。`pnpm smoke` **357/357**（+6 摆放规则断言）；契约 70 命令 / 9 事件 / 26 错误码、可达性 164/72/145、核心 241/241 全绿。打包版真机实测：初始 (580,848) → 移到 (200,300) → 关闭 → 重启后仍出现在 (200,300)。此前第六十二轮（R62）：**缓存上限可配**（第 70 条命令）。① 新增 `system.cacheConfig{limitBytes}`：只接受 128 MiB ~ 32 GiB，越界 → `common.invalid_argument`（带 min/max）；读写分开（`cacheStatus` 只读、`cacheConfig` 只写），界面刷新不会误改设置。② 设置存 `<data>/cache-settings.json`（**不在 cache/ 里**），`clear{all}` 不会重置它；写入用临时文件 + rename。③ 改完**立即按新上限淘汰一次**，`cacheStatus` 回带 `limitBytes/limitMinBytes/limitMaxBytes`，界面不再写死边界。④ 设置页缓存卡片：上限从只读文字变成**几档可选**（256 MiB ~ 8 GiB）+ 说明「按最久没播淘汰、调小立即生效、只缓存播放过的」。`pnpm verify` 五道全绿：smoke **351/351**、契约 **70 命令 / 9 事件 / 26 错误码**、可达性 164/72/145、核心 **241/241**（新增 1 项集成测试：默认值 / 越界不改设置 / 生效 / **清缓存后设置仍在** / 压小上限立即淘汰最旧）。此前第六十一轮（R61）：**不同第三方不同策略的落点——收藏夹选择**（第 69 条命令）。① ABI 新增可选 `getFavoriteCollections()` → `[{id,title,count?}]`，`getFavorites(page, collectionId?)` 多一个参数（只实现默认列表的插件忽略它即可）；新增 `catalog.favoriteCollections{source}`，`catalog.favorites` 支持 `collectionId` 并原样回带。② 缺能力**不是错误**：只有一份默认收藏的源返回空数组（否则每个普通源都弹一次错误）；每家怎么列收藏夹（B 站媒体列表 / QQ 音乐自建歌单）都留在插件里，应用只认 id/title/count（ADR-0005）。③ 界面：源收藏面板在该源有**多份**收藏时才出现第二个选择器（带数量），选中即重取；单份收藏不打扰用户。④ 顺手修掉一个静默问题：`broken_cache_entry_falls_back_to_the_plugin` 的 `#[test]` 被写在注释行尾，**这个测试从来没跑过**——补回后核心单测 237 → **240**。`pnpm verify` 五道全绿：smoke **349/349**、契约 **69 命令 / 9 事件 / 26 错误码**、可达性 163/72/145、`cargo test -p gently-core` **240/240**。打包版实测：测试插件给两份收藏夹 → 源收藏下方出现收藏夹选择器，切换后列表随之变化。此前第六十轮（R60）：**源侧收藏夹**——登录之后要有用处。① ABI 新增可选 `getFavorites(page)`，核心新增 `catalog.favorites{source, page?}`（第 68 条命令）：源必须已启用且**运行时探测到该能力**（缺能力 → `common.not_implemented`、未安装/已禁用 → `common.not_found`）；`hasMore` 只认插件的 `isEnd === false`，缺字段当作没有下一页。② **刻意不缓存**：收藏是用户自己的状态，随时会在别处变化，缓存一分钟就可能显示已取消的收藏——测试用插件调用计数钉住。③ 界面：「我的收藏」拆成**本机收藏 / 源收藏**两个 tab（本机库快照 vs 账号里、需要登录、断网就没有），源收藏按源切换、刷新、加载更多，错误按码说清楚；浏览器预览不出现任何源（不拿演示数据冒充）。④ 清单/沙箱三处同步新增 `getFavorites`（预扫描、运行时探测、bootstrap 收集名单），少一处就会「插件写了核心说没有」。`pnpm verify` 五道全绿：smoke **346/346**、契约 **68 命令 / 9 事件 / 26 错误码**、可达性 161/72/145、`cargo test -p gently-core` **237/237**。打包版实测：实现 `getFavorites` 的测试插件 + 完成授权 → 源收藏列出两行，行标题由插件用**它读到的令牌**拼出（`已登录 token-demo-3`），深浅主题都可读。此前第五十九轮（R59）：**第三方授权（待完成项 6 的抽象）**——通用 OAuth 2.0 授权码 + PKCE，端点由**插件清单**声明，应用不内置任何第三方地址（ADR-0008）。① 清单新增 `@oauth`（`authorize` / `token` / `client` / `scopes` / `port` / `pkce`；目录包写成 `oauth` 对象），端点域名必须在 `@hosts` 内且只允许 HTTPS（本机回环例外），声明即自动补 `network` + `credentials` 权限。② 核心新增 `core/src/oauth.rs`：`auth.begin` 绑 `127.0.0.1` 随机端口等回调（180s 上限）、**校验 `state`**、用授权码换令牌（带 `code_verifier`）、过期不足 60s 时用 `refresh_token` 就地续期；令牌只进系统凭据库（键 `__oauth_token`），日志只记「成功/失败 + 过期时间」。③ 新增 4 条命令（契约 63 → **67**）：`auth.status/begin/cancel/signOut`——`status` 只回状态，**命令层没有读令牌的出口**；新增事件 `auth:changed`（8 → **9**）。④ 沙箱新增 `oauth.getAccessToken()`（只有声明 `@oauth` 的插件有值）；`credentials.get('__…')` 一律 `undefined`（`__` 是宿主保留键）。⑤ 插件管理面板新增「第三方授权」卡片：授权（交给系统浏览器）/ 取消等待 / 退出登录（走 `useConfirm`），并如实说明端点来源、令牌落点与 PKCE 关闭风险。⑥ 两个拍板：版本号**不提前提 1.0.0**；**主题控制面板不做**（ADR-0007 §1.1）。`pnpm verify` 五道全绿：smoke **341/341**、契约 **67 命令 / 9 事件 / 26 错误码**、可达性 159/72/144、`cargo test -p gently-core` **236/236**（`core/tests/oauth.rs` 用 `127.0.0.1` 模拟授权服务器跑完整链路，不连任何真实第三方）。此前第五十八轮（R58）：**1.x 收口的第一段——版本规划、pet 接口预留、下载文件的「在文件夹中显示」**。① 新增 `docs/adr/0007-versioning-and-pet-extension.md`：0.x 为开发期；待完成项 1–6 全部验收后发 **1.0.0**；1.x 只修不扩；pet 元素属于 **2.0**。版本号本轮**未动**（仍 `0.1.0`，是否打 1.0.0 待拍板）。② 预留 pet 扩展点（`src/pet/`，无新契约命令）：`PetDefinition` / `PetInstance` / `PetContext` + 注册表（`register`/`list`/`subscribe`，同 id 覆盖且**旧 disposer 不得移除新注册**）+ `petPlaybackSnapshot`（只读播放快照）+ `PetHost`（无宠物时渲染 null，不占位、不加载任何资源）；**只留接口，不做内置宠物**。③ 下载列表新增「在文件夹中显示」：走已存在的 `system.revealPath`（`fileService.revealInDir`），打包版实测真的打开了 `%APPDATA%` 下的下载目录并选中该文件。④ 冒烟 +6（pet 注册表 / 宿主 / 快照 / 下载行动作）= **332**。`pnpm verify` 五道全绿：smoke **332/332**、契约 **63 命令** / 8 事件 / 26 错误码、可达性 153/72/143、`cargo test -p gently-core` **220/220**。此前第五十七轮（R57）：**桌面歌词（待完成项 4）**。① 第二个 Tauri 窗口 `desktop-lyrics`：无边框、置顶、跳过任务栏、启动时隐藏；URL 是 `index.html?window=desktop-lyrics`，`main.tsx` 按 query 决定挂载完整应用还是 `DesktopLyricsApp`（构建产物仍只有一份）。② 主窗口工具栏新增「桌面歌词」按钮（独立图标 + 按下态），经窗口服务显示/隐藏；每次显示摆到屏幕底部居中。③ 两个窗口是独立 WebView、store 不共享：主窗口用窗口间事件 `gently:lyrics:update` 推 `{title, artist, line, next, translation, playing, empty, source, themeMode}`（行/播放态变化立即推 + 1s 心跳），歌词窗口渲染并监听；关闭按钮隐藏自己并推 `gently:lyrics:closed`，主窗口据此恢复按钮状态。④ 歌词窗口复用 `activeLyricIndex` 高亮判断；支持 A−/A+ 字号（按窗口本地记住）、深浅主题随主窗口同步（独立 WebView 不会自动跟随）。⑤ 打包版实测：真实 NetEase 曲目 → 桌面歌词窗口显示当前行/下一行/曲目/来源；A+ 两次字号变大；点 × 后窗口隐藏且主窗口按钮恢复未按下；主题切换后歌词窗口跟着变深/变浅。`pnpm verify` 五道全绿：smoke **326/326**、契约 63 命令 / 8 事件 / 26 错误码、可达性 153/72/138、`cargo test -p gently-core` **220/220**。此前第五十六轮（R56）：**离线可用的第一块——播放缓存**。① 核心新增 `cache.rs`：`playback.resolve` 解析成功后**在后台**把这首歌补进 `<data>/cache/media/`（`.part` → 原子 rename，元信息 sidecar 记 reference/quality/source/bytes/at）；只缓存**播放过的**，单文件 256 MiB、总量 1 GiB，超出按最旧淘汰；**缓存命中优先于插件解析**（命中直接走同一条回环代理并返回 `fromCache: true`，断网/插件停用/卸载时已缓存的那首仍能播）。② 新增 `system.cacheStatus` / `system.cacheClear{kind}`（第 62/63 条命令）：设置页「缓存」卡片显示播放缓存 / 歌词与详情 / 封面三块占用与 1 GiB 上限，可分别清理或全部清理（走 `useConfirm`）。③ 歌词缓存 TTL 从 6h 提到 30 天，且 `call_detail` **先读缓存再检查插件**——断网或插件卸载后歌词/详情仍可看。④ 顺带修掉一个真 bug：`playback.resolve` 之前**不看插件启停状态**（停用后仍会解析），现在与搜索一致「禁用立即生效」；缓存命中分支在检查之前，所以不影响离线播放。⑤ 打包版实测：播一首真实 B 站曲目 → 缓存落盘 10.6 MB / 1 个文件（`r56-08-cache-card.png`）→ 设置页清理 → 0 KB 并提示「已清理 2 个文件（10.6 MB）」（`r56-09-clear-confirm.png`）；Rust 集成测试 `played_tracks_are_cached_and_playable_when_the_source_is_gone` 覆盖「停用插件后仍从缓存播 + 清理后返回 null」。`pnpm verify` 五道全绿：smoke **322/322**、契约 **63 命令** / 8 事件 / 26 错误码、可达性 147/71/134、`cargo test -p gently-core` **220/220**。此前第五十五轮（R55）：**歌词与歌曲分离的问题有了第一个真正的产品入口**。① 新增核心命令 `catalog.lyricsSearch{query, limit?}`（第 61 条命令）：每个已启用且同时具备 `search`+`getLyric` 的源各起一个线程，先按关键词搜歌、再取前 N 个条目问歌词；单源失败/无词只跳过该条，整体 12s 截止并返回 `{items, searchedSources, failedSources, skippedSources, timedOutSources}`，歌词按 `lyrics:<source>:<rawId>:false` 与 `catalog.lyrics` 共用缓存。② 歌词页新增「搜索歌词」面板：预填当前歌名+歌手、结果显示**来源名称、曲目标题/歌手、首行歌词**，点「使用」替换当前歌词并显示来源；面板可收起，桌面端/浏览器预览分别给出诚实提示。③ 时间轴校正是**逐曲目持久化**的：`±0.5s`/归零，渲染用 `elapsed + offset`、点行跳转用 `line.time - offset`（`utils/lyricsOffset.ts`，上限 30s、500 首）；手动选中的歌词不会被迟到的自动结果覆盖。④ 用用户提供的 `examples/wangyiyun.js` 里的接口做了一份**依赖清零**的本地测试插件（`release/plugins/wangyiyun.js`，git 忽略）在打包版上实测：搜索命中 2 份歌词 → 使用 → +1.0s → 重启后偏移仍在。`pnpm verify` 五道全绿：smoke **319/319**、契约 **61 命令** / 8 事件 / 26 错误码、可达性 145/71/134、`cargo test -p gently-core` **219/219**（新增 lyricsSearch 集成测试）。此前第五十四轮（R54）：**用户实测报来三个窗口 / 导航 bug，逐个修掉；顺手把设置页里那排占位下载项做成真的能用**。① 最大化 / 向下还原是**同一个图标**：标题栏只读 `isTauri()`、从不读窗口状态 → 新增 `IconRestore`（双窗格）+ `windowService.isMaximized/onResized`（订阅真实窗口尺寸变化，双击拖动区最大化也跟着变），最大化时图标与文案都切成「向下还原」。② 歌词页**返回要点 N 次**：播放条在歌词页里仍然可见，点封面又 `navigate('/now-playing')` 压一条重复历史 → 已在歌词页时不再压栈（`shouldOpenNowPlaying` 纯函数 + 冒烟断言）；返回按钮在历史栈底时回首页而不是退出应用。③ `decorations: false` 时窗口**拖不动**：标题栏根本没有拖动区 → 挂 `data-tauri-drag-region="deep"`（按钮/输入框按 Tauri 语义自动阻断拖动，空白处与 Logo 才是拖动区）并在 capabilities 补 `core:window:allow-start-dragging`。④ 设置页下载卡片原来是 `example path` / `3` 这种假值（还留下 6 个未使用的 i18n 键，被死键守卫拦下）→ 做成真设置：下载目录（留空=核心默认目录，透传 `download.create.dir`）、默认下载音质、首选档位不可用时「改用更低/更高」（纯函数 `pickQualityWithFallback`），以及「最多同时下载歌曲数」——所有新任务先入队，由 store 的 `pump()` 按槽位交给核心（`running` 记账，暂停/失败/完成都释放槽位；「继续」也排队，避免连点绕过上限）。`pnpm verify` 五道全绿：`pnpm smoke` **312/312**（+13）、契约 60 命令 / 8 事件 / 26 错误码一致、可达性 143/69/133 通过、`cargo test -p gently-core` **218/218**（本轮无 Rust 改动）。此前第五十三轮（R53）：**用户实测报来四个 bug + 一个插件需求，逐个复现并修掉**。① `D:\Xun\Music` 有文件却扫描为 0：音频扩展名白名单漏了 `.m4s`（B 站下载的音频就是这个后缀，与 `.m4a` 同属 ISO-MP4 容器）→ 补 `m4s`/`m4b`/`m4r`，并新增 `ignored`（非音频文件数），让「有文件但都不是音频」不再和「目录是空的」显示成同一句话。② UI 显示异常：表格列宽**下限合计 832** 撑不进最小窗口的内容区 612（「大小 / 操作」被切到窗口外，只剩横向滚动条与半截表头），窗口又**没有默认宽度**（Tauri 默认 800 被 `minWidth 900` 顶到 900，装完打开的那一刻正好是最窄布局），播放条 `@media (max-width:900px)` 还把右侧整组控件（音源/音质/循环/队列/抽屉）整块 `display:none` → 列下限收到 **610**、窄窗只收音量与秒数、默认窗口改成 **1280×800**。③ 真实 MusicFree 插件 `catalog.topList` 报 404：宿主把**字符串 id** 交给「收条目对象」的 MusicFree 详情函数（`topListItem.id` 是 undefined → URL 拼成 `.../x/web-interface/undefined`），`getMediaSource(musicItem)` 同样拿不到 `bvid`/`aid`/`cid`（「能搜、能看榜单，一播就挂」）→ 核心在归一化时留下**插件原始条目的进程内快照**（LRU、不落盘），详情/播放解析对兼容插件原样交回，沙箱再把字符串包成 `{id}` 兜一层，**自有 ABI 仍只收字符串 id**。④ 生产版不该有 mock 数据（同轮细节见后）。⑤ 按用户那份真实 MusicFree 插件移植出单文件 ABI 插件 `release/plugins/bili-audio.js`（依赖清零、`@hosts` 声明式白名单、`id = <bvid>|<cid>` 自带播放定位），`plugin-tool check` 与真实接口逐条自测通过。**④ 开发/生产数据隔离的细节**：根因是 `src/plugins/index.ts` **无条件**注册了三个假音源（`mock` / `bilibili` / `netease`，数据来自 `src/mock/**`，其中还捆着一份 4.4MB 随包音频当「可播放地址」），且 `libraryService.loadPlugins()` 把「核心那份 + 前端演示源 + `qqmusic`/`kugou` 占位」合并返回。修法：模块顶层判定 Tauri 宿主（与 `window.service.isTauri()` 同一条件），**只在没有宿主时**用动态 `import()` 注册演示源（Vite 因此把它摇成独立 chunk，不进主包）；`loadPlugins` / `suggest` / `fetchAlbum` / `fetchCuratedPlaylist` / `searchAll` 一律只在 `!coreAvailable()` 时退回 mock，核心在却读失败就返回空并如实报错；`getActiveMusicSource()` 不再抛异常（设置页在渲染期调它，应用没有错误边界，会整页白屏），改经新的 `catalogService.activeSource()` 拿 `null` 并显示「还没有安装任何插件」；热搜词、插件「有更新」的假版本号、下载失败项的假大小/假速度同样只在浏览器预览里出现；搜索页在「一个音源都没装」时不再说「没有找到相关歌曲」。`pnpm build` 通过、`pnpm smoke` **299/299**、契约一致、可达性通过（服务节点 141 / 动作 65 / 界面 133）。此前第五十九轮（R52）：**交付物冻结后的最终验收**——把 `release/gently-0.1.0-windows-x64.zip` 解到另一个目录、用解出来的那份 exe 冷启动全新数据库：内层 exe 哈希 `37f40a22…c292` 与 `.sha256` 逐字符一致；8 条迁移跑完、`SQLite 就绪 schema_version=8`、凭据后端 `windows-credential-manager`；`GENTLY_LOG=debug` 下 `library.favorites.list / skin.list / system.status / library.playlists.list / plugin.list` **全部 `ok=true`**（默认 info 级别不写 dispatch 行，所以「日志里没有 dispatch」不等于前端没调核心）；点开主题市场 10 张内置卡片只有「应用」/「使用中」、**没有「删除皮肤」**——上一轮的修复确实在交付版里。本轮无源码改动，`pnpm verify` 五道全绿（smoke 296/296、核心 212/212）。此前第五十八轮（R51）：**顺着上一轮刚改过的主题市场看「删除皮肤」这条边，抓到一个真 bug**——每个**内置**预设卡片上都长着「删除皮肤」按钮，点它→确认→界面提示「已删除皮肤「深海蓝」」，而卡片纹丝不动。根因是一条完整的错误链：视图守卫写的是 `!item.builtin`，但 `presets.json` **从来没写过 `builtin` 字段**（`undefined` 让守卫失效）→ 点下去 store 只过滤用户皮肤（无事发生）→ 核心 `skin.remove{id:ocean}` 必然 `skin.not_found`（核心只认识用户导入的皮肤）→ 失败被 `void` 掉 → 视图却无条件提示「已删除」——**成功提示与事实相反**。修法是一处收口：`presets.ts` 里给内置皮肤统一补 `builtin: true`（删除守卫与「导出要不要问核心」读的是同一个标记），冒烟加断言「内置预设全部带 builtin」。打包版实测：内置卡片只剩「应用」，粘贴 JSON 导入的「探针皮肤」卡片带「删除皮肤」，点它→确认→`skin.remove ok=true`、卡片消失、品牌色回默认、`skins` 表 0 行——**导入→应用→删除整条生命周期走通**。`pnpm smoke` 296/296、`pnpm verify` 五道全绿（核心 212/212）；前端有改动已重新打包。此前第五十七轮（R50）：皮肤导入补两条粘贴来源（消除原生选择器盲区）；**把「皮肤导入」补成和插件导入一样可靠**——上一轮查清原生选择器「弹得出来但合成输入驱动不了它」，与其把这条路留在「只能人手点」，不如按插件页早就验证过的做法补两条粘贴来源（核心侧 `skin.preview`/`skin.install` 收的本来就是同一个 `ImportSource`）。改动：服务层加 `skinService.importFromPath`（`{kind:file}`，浏览器预览按路径读不了文件就如实拒绝）；主题市场的「导入皮肤」按钮改成**展开导入面板**（来源标签「粘贴 JSON / 本机路径」+ 右侧仍保留「从文件选择…」），导入成功即应用并收起、失败按「被拒键名 → 错误码文案 → 原因」逐级显示；文案 zh/en 成对补齐；样式第一次提交时用了不存在的 `--card-padding`/`--font-mono`，**被 CSS token 守卫当场拦下**（已改用既有 token）。打包版实测：粘贴 JSON → 日志 `skin.preview ok=true` + `skin.install ok=true`，全站品牌色立刻变成皮肤里的品红，`skins` 表出现 `probe-skin`——**上一轮那条自动化盲区消失**。冒烟 +2 条假宿主断言（paste/file 两条来源都真的走 preview+install）→ 295/295；`pnpm verify` 五道全绿（核心 212/212）。因前端有改动重新打包，exe/zip 已更新。此前第五十六轮（R49）：对话框坐标系修复 + 皮肤导入边界；**修掉上一轮那个工具 bug，再试把皮肤导入走完**。修法：新增 `dialog` / `shotdlg` / `clickdlg` 三步——先把「当前前台窗口」**记成对话框句柄**，之后截图与点击都以它为准，不再跟着会漂移的前台走；配上 `nofocus`，并且用 `IsWindowEnabled(主窗口)` 当「模态窗开没开」的硬判据。复现结果**一半成功、一半卡住**：点「导入皮肤」确实弹出模态的 Win32「打开」对话框，`clickdlg` 到「文件名」再粘贴**能让完整路径落进字段**（截图可见），但**点「打开(O)」与回车都不生效**，对话框一直开着、核心侧始终没有 `skin.preview`——合成输入能进文本框（那个框默认就有焦点），却驱动不了对话框自己的按钮。**如实记为未覆盖**：皮肤导入的产品行为没问题（人手动选一个文件即可），核心链路另有 8 项 `skin.rs` 测试 + 冒烟的服务层断言，只有「选择器 → 读文件文本」这一小段浏览器 API 胶水没能在真机上自动验过，不拿「选择器弹得出来」冒充端到端通过。本轮无产品源码改动，`pnpm verify` 五道全绿（smoke 293/293、核心 212/212）。此前第五十五轮（R48）：原生选择器可用性查证 + README 措辞澄清；**把「导入皮肤」这条唯一没验过的用户路径验清楚**——它走的是 WebView 自己的 `<input type=file>` 原生选择器。结论：**原生选择器是有的**（AGENTS 那句「没有原生文件选择器」只对 Tauri 的 dialog 插件成立）：同一行工具栏的「导出」点了会落盘（证明点击有效），点「导入皮肤」后主窗口 `IsWindowEnabled` 从 True 变 **False**（模态窗的铁证），再用新加的 `shotfg:` 截**前台窗口**，拍到的就是标准 Win32「打开」对话框（`skin-file-dialog.png`）——所以这颗按钮不是死按钮。**边界如实记录**：继续用模拟输入驱动那扇对话框时，路径确实进了「文件名」框，但回车/点「打开」都没能让它生效（核心侧没有 `skin.preview`）——大概率是几步之间前台窗口被换走，而 `clickfg` 按当前前台窗口算坐标，前台变成应用窗口时坐标就落空了；端到端没跑通，不粉饰。为此给驱动脚本加了三个能力：`nofocus` / `shotfg` / `clickfg`。本轮无产品源码改动，`pnpm verify` 五道全绿（smoke 293/293、核心 212/212）。此前第五十四轮（R47）：交付物 zip 解压验收 + 便携说明纠错；**验收「用户真正拿到的那份东西」**——把 `release/*.zip` 解压到干净目录、跑解压出来的 exe、逐字读它随包的说明。结果抓到一处**交付物里的事实错误**：`README-便携版.txt`（用户解压后第一眼看到的那份）仍在「已知限制」里写「第三方凭据当前存在内存里，重启后需要重新填写」，而 Windows 的凭据管理器早已接上（诊断卡片实测 `windows-credential-manager`「已接入系统凭据库（重启后仍在）」）——改掉打包脚本里的说明模板并重新打包。验收其余项都过：解压目录只有 exe + 两份 README；解压出来的 exe 与打包目录里的**SHA256 完全相同**（`2bb411c8…22ce`）；从解压目录启动照常 `SQLite 就绪 schema_version=8`、迁移 8 条、诊断卡片与仓库构建版**逐像素一致**。本轮无源码改动，`pnpm verify` 五道全绿（smoke 293/293、核心 212/212）。此前第五十三轮（R46）：安装包工具链查证 + 浏览器预览实测；**两件收尾**。①「安装包」这条待办查证过：本机没有 candle/light/wix/makensis，也没有 `%LOCALAPPDATA%\tauri` 缓存与 WiX/NSIS 安装目录——打 MSI 确实得先联网取 WiX，环境受限成立（不是想当然）。②顺手发现**交付物里的文档是旧的**：zip 内那份 README 还写着冒烟 287 项、没有内嵌封面那段；`pnpm package:portable` 重新打包后 zip 内 README 已是当前版本，**exe 字节未变**（`2bb411c8…22ce`）。③把**浏览器预览**这条从没在真实浏览器里验过的路走通了：`pnpm build` + `pnpm preview` → 用 Edge 应用窗口打开 → 排行榜/下载管理都正常渲染 mock 数据，设置页诊断卡片如实显示**「浏览器模式」**且不出现核心那一串行（没有拿假信息冒充核心）。为此把驱动脚本升级成通用窗口驱动：新增 `-ProcessName` / `-AppUrl`，并把窗口查找改成**遍历全部同名进程**取最大可见窗口（Edge 是多进程的，以前只取最新进程会直接找不到窗口）。本轮无源码改动，`pnpm verify` 五道全绿（smoke 293/293、核心 212/212）。此前第五十二轮（R45）：文档一致性审计；**文档一致性审计**——代码侧验收已通，但文档里的数字与状态已经开始跟不上：①`AGENTS.md` 还写着「当前阶段：UI/前端交付，数据全部为 mock」，实际核心早已实现契约全部 60 条命令（沙箱/本机库/内嵌封面/回环代理/推荐/皮肤/下载/订阅），mock 只是浏览器预览兜底；②AGENTS/README 的冒烟与核心单测数还是 287/207（实测 293/212）；③`ARCHITECTURE.md` 的依赖图还说 mock 是「后续被插件替换」，核心框图写着「规划中」且缺封面缓存/推荐；④`ROADMAP.md` 的 M0–M5 里程碑标题停在「进行中」/无状态，现在逐个标成**已完成**并点名证据（只剩联网打 MSI/NSIS 与人工听感两件环境受限项）；⑤STATE 验证表的冒烟数、刻意留白清单（补上 action `actions.player.stop`）也一并对齐；⑥契约 §11 的性能预算补上 R39 的实测口径与测量入口。顺带扫过：代码里没有 TODO/FIXME 占位，契约三处一致。本轮只改文档，交付物同上轮（exe `2bb411c8…22ce`）；`pnpm verify` 五道全绿（smoke 293/293、核心 212/212）。此前第五十一轮（R44）：设置页诊断卡片 + 危险确认开关；**把设置页这块没看过的界面走了一遍，两个点都验到底**。①本机核心诊断卡片里的每一项都与真实环境对得上（核心 v0.1.0 / windows-x86_64 / 数据库已就绪 / 凭据存储 `windows-credential-manager` / 条目统计 0·0·0·0 / 数据与日志目录真实路径），两个「打开目录」按钮点了就是 `system.reveal ok=true`。②「危险操作前二次确认」切到**禁用**后，回本地曲库点「移除」**确实不再弹确认框**——`library.local.remove ok=true` 直接落库、`local_tracks` 3→2，把「设置项 → useConfirm → 危险操作」整条链走通了，而不是只看开关的字面状态。本轮无源码改动，交付物同上轮（exe `2bb411c8…22ce`）；`pnpm verify` 五道全绿（smoke 293/293、核心 212/212）。顺带记一条坐标教训：设置页右侧那排「确定/禁用/浅色/深色」是**纯文本按钮，命中区就是字形**，按行中心估会落到两个词中间。此前第五十轮（R43）：干净环境完整链路（退出标准）；**在干净环境里把 ROADMAP 的退出标准跑了一遍**——此前每一环都单独验过，但从没在同一次会话里连着走完。清空数据目录后一次会话依次完成：启动建库（迁移 8 条）→ 扫描本地目录（`local_tracks=3`）→ 播放本地曲目（回环代理 206）→ 收藏它 → 从「本机路径」导入夹具插件（预览权限 → 勾选同意 → `plugin.import`/`plugin.reload`，日志 `插件已加载 probe-source capabilities=[Search, GetMediaSource, GetTrackInfo, GetLyric]`）→ 流式搜索（`catalog.search`，结果带插件封面）→ 播放插件曲目（`catalog.track` + `catalog.lyrics` + `playback.resolve`；离线取不到上游时进度改走模拟时钟）→ 收藏插件曲目（`favorites` 里同时有 `local:…` 与 `probe-source:1`）。结论：退出标准的**代码侧全部满足**，只剩「联网打 MSI/NSIS」与「人工听一次扬声器」两件环境受限的事。本轮无源码改动，交付物同上轮（exe `2bb411c8…22ce`）；`pnpm verify` 五道全绿（smoke 293/293、核心 212/212）。此前第四十九轮（R42）：插件链路重新验收 + `getMediaSource` 参数形状写进契约；**改动十几轮之后把插件整条链路重新验收了一遍**：从「本机路径」导入夹具插件（`plugin.preview` 列出权限 + 「将覆盖同 id 插件」提示 → 勾选同意 → `plugin.import`/`plugin.reload`）→ 沙箱流式搜索（`catalog.search`，结果带插件的 data-URI 品红封面、时长按 durationSec 归一化、来源徽标）→ 播放（`playback.resolve` + `catalog.track` + `catalog.lyrics`，回环代理按预期因离线取不到上游）。结论：R37–R43 的改动没碰坏插件链路，插件的 `artwork` 在新封面列里照常渲染。另外把 `getMediaSource(track, quality)` 的坑写进契约：第一个参数是**曲目对象**不是字符串 id（夹具第一版拼出 `probe-[object Object].mp3`，命令全 ok 只有翻上游日志才看得出来；`getTrackInfo/getLyric` 才是字符串 id）。本轮无源码改动，交付物同上轮（exe `2bb411c8…22ce`）；`pnpm verify` 五道全绿（smoke 293/293、核心 212/212）。此前第四十八轮（R41）：循环模式 + 主题市场 + 内置预设导出不再问核心；**把循环模式与主题市场这两块没走过的功能面走了一遍**。①循环模式：连点按钮能看到品牌色按下态（`repeat-phases.png` 放大三态对照），先设成 `all` 再放 3 秒的 WAV，日志出现**连续 5 个循环**（每组 `playback.report` + `recommend.feedback complete` + 紧接着新的 `playback.resolve`）——「循环播放全部」确实绕回队首重播；顺带记一条教训：截图很慢，先截图再点按钮会把点击推到曲目播完之后，看起来像「循环没生效」。②主题市场：应用「深海蓝」→ `skin.setActive ok=true` 且全站配色立刻变；导出皮肤真的落盘（Downloads 里 819 字节的合法 JSON），WebView2 下载通道可用。③照出一个「问错对象」：导出**内置预设**会去问核心（核心只有用户皮肤）→ `skin.export not_found 皮肤未安装：ocean` 的误导性告警，然后前端再退回本地序列化；改成内置预设直接前端序列化、用户皮肤才取核心原文（与 R27「演示源不问核心」、R37「本地曲目不问歌词」同一类收口），打包版复测告警消失、文件照常落盘。`pnpm verify` 五道关卡全绿（smoke 293/293、契约一致、可达性通过、核心单测 212/212）。此前第四十七轮（R40）：drag 工具 + SeekBar/音量/详情页 + 两个下载 bug；此前第四十六轮（R39）：截图抓到上一帧 + 行内操作列裁掉「播放/收藏」；此前第四十五轮（R38）：新建歌单静默失败 + 快照封面地址过期；此前第四十四轮（R37）：**本地文件的内嵌封面做完了，而且真的能看见**——核心扫描时把文件里的图落进 `<data>/cache/covers/<源路径哈希>.<ext>`，列表只多一个回环地址 `http://127.0.0.1:<port>/cover/<name>`（媒体代理新增的第三条路由，只服务这个目录、穿越与非法名一律 404）；前端零改动即可显示，顺手给业务列表的标题列加了封面缩略图（新 token `components.table`），六处列表一起受益。过程中照出**三个真 bug**：①扫描侧用文件系统路径（Windows `\`）写、列表侧用库里统一的 `/` 回查 → 哈希对不上，封面永远找不到（负向验证：去掉归一化测试立刻红）；②**symphonia 0.5.5 的 mp3 demuxer 不解析 ID3v2**，标签与封面只在探测的**链式元数据**里 → 之前本地 mp3 的标题/歌手/专辑/封面全都读不到（改为一并读取，用手写 ID3v2.4 夹具端到端钉住）；③粘贴 `C:\\…\\dir`（重复分隔符，Windows 照样认）会把同一个文件收成**两行**，旧行还永远清不掉、清理时顺手删掉活着那行的封面（路径归一化收成一份实现 + 清理前先看有没有活着的同源曲目，正反两向都验过）。封面提取的**两条路径各有离线夹具**：mp3（ID3v2/APIC，链式元数据）与 FLAC（PICTURE 块，容器元数据，夹具里手写了合法音频帧 + 帧头 CRC-8 / 帧尾 CRC-16）。另外本地曲目不再问核心要歌词（此前每次播放都在日志里留一条「插件未安装：local」）。`pnpm verify` 五道关卡全绿（smoke 287/287、契约一致、可达性通过（**无未归档的死动作**）、核心单测 211/211）。打包版实测：扫描三个夹具（mp3 品红封面、FLAC 青色封面、无封面）→ 逐像素核对两种格式的缩略图都是内嵌图原色、无封面那行是渐变；播放后播放条封面也是内嵌图；另外，同一文件按重复分隔符拼写也不会再收成两行（旧重复行会在下次扫描被清掉，且不会顺手删掉封面）。契约 §11 的性能预算也量了：1000 个 WAV 首扫 124 ms / 重扫 21 ms / 检索 P95 1.11 ms（外推 1 万文件首扫 ≈1.2 s，预算 10 s）。此前：R36 播放态复核、R35 播完结算、R34 本地播放路由、R33 假疑点澄清、R32 插件链路真实验收、R31 曲目详情接线、R30 截屏/驱动工具、R29 可达性守卫、R28 本地库扫描入口、R27 事件名与源路由、R26 测试隔离。
---

# STATE

## 本轮目标

**源侧收藏夹（待完成项 6 的「具体能力」）——R60**：登录之后要有用处——让源把自己账号里的收藏拿出来：

1. ABI 新增可选 `getFavorites(page)`，核心新增 `catalog.favorites`（第 68 条命令）；
2. 我的收藏分成「本机收藏 / 源收藏」两块（存在哪儿、为什么找不到，用户要能分清）；
3. **不缓存**源收藏（用户自己的状态，随时会在别处改动）；
4. 缺能力 / 未登录 / 已禁用各有明确说法，不糊成一句「拿不到」。

**仍未完成**：缓存上限自定义、下载逻辑收尾、桌面歌词的位置记忆；B 站收藏夹这类**具体源**由用户装的
插件实现（应用不内置任何第三方实现，ADR-0005）。

## 已完成（第六十四轮）

### 1. 桌面歌词：锁定（点击穿透）

歌词条是**置顶**窗口，横在屏幕上就会挡路（尤其看视频/写东西时）。这一轮给它一个「锁定」开关：

- 设置页新增「桌面歌词」卡片：**不锁定 / 锁定**。锁定后 `setIgnoreCursorEvents(true)`，
  鼠标点击穿透到下面的窗口；
- **解锁只能在设置页**：锁定后歌词窗口自己收不到任何点击（包括它自己的 `×` / `A±`），
  把解锁按钮放在它自己身上等于死锁；
- 状态持久化在 `localStorage`（`gently:lyrics-locked`），**每次显示都重新同步一次**
  （`true` / `false` 都写）：窗口 API 失败时我们查不到真实状态，靠「下次显示再同步一遍」自愈——
  否则用户锁上之后若解锁调用失败，就再也点不到歌词条了；
- 顺带修掉一个会让开关「看起来没反应」的问题：状态更新改成**先切界面再落盘**（`void` 异步写），
  之前是 `await` 之后才 `setState`，任何一次写失败的等待都会让点击看起来无效。

### 2. 验证

- `pnpm smoke` **360/360**（+3：默认不锁定、锁定状态被持久化、可以再解锁）；
- 其余四道全绿（契约 70 命令 / 9 事件 / 26 错误码、可达性 164/72/145、核心 241/241）。

**打包版实测**（真机 Win32 驱动）：

| 验什么 | 结果 |
|---|---|
| 设置页入口 | 「桌面歌词 → 锁定歌词窗口（鼠标点击穿透）」不锁定 / 锁定 两档（`r64-lock-sweep2.png` 选中锁定态） |
| 锁定后点击穿透 | 锁定 → 打开歌词窗口（记忆位置仍在 `(200,300)`）→ 点它的 `×`：**窗口没有关闭**，点击穿透了 |
| 状态跨重启 | 重启应用后设置页仍显示「锁定」，且歌词窗口显示时再次被设为穿透 |

**未验证项（如实登记）**：解锁方向（点「不锁定」后 `×` 恢复可点）**没能在打包版上验成功**——
驱动脚本对这个单选控件的命中点不稳定（同一坐标有时命中「锁定」、有时完全没反应，
`SetIgnoreCursorEvents` 生效后自动化点击更容易落到别处）。代码上解锁与锁定是同一条命令的
`true/false`，并有「每次显示重新同步」兜底；但**没有实测证据就不算验过**，留到下一轮用更可靠的
驱动方式（或人工点一次）确认。

## 已完成（第六十三轮）

### 1. 桌面歌词记住位置（待完成项 4 的第一条）

R57 的第一版每次显示都回到底部居中——用户拖到别处之后，下次又跳回去，等于「拖了没用」。这一轮补上：

- 摆在**用户上次拖动后的位置**；关闭（主窗口开关或歌词窗口自己的 ×）时先读一次真实坐标存进
  `localStorage`（`gently:lyrics-window-pos`，两个窗口同源共享）；
- **不可见就回退**：判断逻辑抽成纯函数 `src/utils/lyricsWindowPosition.ts`——
  记得的位置至少要有**一半面积**落在某块屏幕里才用，否则（副屏拔了、分辨率变了、第一次打开）
  回到底部居中；可用但有一小半出屏的会被**夹回**屏幕内，保证整条歌词都看得见；
- 窗口权限补上 `core:window:allow-outer-position` 与 `core:window:allow-available-monitors`
  ——第一版其实一直在**静默降级**：`currentMonitor()` 被 ACL 拒绝、异常被 catch 掉，
  所以「摆到底部居中」也没生效过（这次真机验证时才发现，见下）。

### 2. 验证

- `pnpm smoke` **357/357**（+6：底部居中与底边距、记得的位置原样使用、位置不在任何屏幕里回退、
  大半可见被夹回、大半出屏回退、副屏上的位置同样被认可）；
- 其余四道同样全绿（契约 70 命令 / 9 事件 / 26 错误码、可达性 164/72/145、核心 241/241）。

**打包版实测**（真机 Win32 驱动，不靠肉眼看）：

| 验什么 | 结果 |
|---|---|
| 第一次显示 | 底部居中 `(580,848)`（1920×1080 屏、窗口 760×160、底边距 72） |
| 拖到别处再关掉 | `SetWindowPos` 移到 `(200,300)` → 点歌词窗口的 `×` → 窗口隐藏（`r63-01-lyrics-window-at-custom-pos.png` 是移到 200,300 后的样子） |
| 重启后仍记住 | 杀掉进程重新启动、再点开桌面歌词 → 出现在 **`(200,300)`**，不是底部居中（`r63-02-lyrics-restored-position.png` 是重启后截的窗口本身） |

**边界如实记录**：仍然是「多个显示器只按位置校验、不按 DPI 逐屏换算」；位置在**关闭时**记录，
所以「拖动后不关窗口直接退出应用」不会保存（下次仍按上次关闭时的位置）；
点击穿透 / 锁定窗口仍未做（要继续做得先决定交互方式：锁定后按钮就点不到了）。

## 已完成（第六十二轮）

### 1. 缓存上限可配（第 70 条命令）

目标里「缓存管理…如缓存上限」原来只是**固定 1 GiB + 只读展示**，这一轮把它做成真的能配：

- 新增 `system.cacheConfig{limitBytes}`：只在 **128 MiB ~ 32 GiB** 之间接受，越界 →
  `common.invalid_argument`（`details` 带 `min`/`max`，界面直接把边界显示出来）；
- **读写分开**：`cacheStatus` 只读、`cacheConfig` 只写——界面每次刷新都调 status，
  如果它能写，一次参数错误就能改掉用户的设置；
- 设置存 `<data>/cache-settings.json`（**不在 `cache/` 里**）：`clear{kind:"all"}` 不该把
  用户设的上限一起重置；写入用「临时文件 + rename」，半截文件不会被当成合法设置；
- 改完**立即按新上限淘汰一次**：把 1 GiB 调到 256 MiB 之后不该再等下一次播放才瘦身；
  `cacheStatus` 同时回带 `limitBytes / limitMinBytes / limitMaxBytes`，界面不再自己写死边界。

界面（设置页缓存卡片）：上限从一行只读文字变成**几档可选**（256 MiB / 512 MiB / 1 GiB /
2 GiB / 4 GiB / 8 GiB），旁边写明「超出按最久没播淘汰、调小立即生效、只缓存播放过的曲目」。

### 2. 验证

`cargo test -p gently-core` 新增 1 项集成测试（`cache_limit_is_configurable_and_enforced_immediately`）：
默认值、越界拒绝且**不改动已存值**、合法值生效、**清缓存后设置仍在**、以及
「塞两个 80 MiB 文件再把上限压到 128 MiB → 最旧的那个被删、较新的留下」。
`pnpm verify` 五道全绿：smoke **351/351**（+2：上限走核心并回带新值、越界被拒）、
契约 **70 命令 / 9 事件 / 26 错误码**、可达性 **164/72/145**、核心单测 **241/241**。

**打包版实测**（当前构建）：

| 验什么 | 结果 |
|---|---|
| 界面有得选 | 设置 → 缓存卡片「容量上限」是六档（256 MB / 512 MB / 1.00 GB / 2 GB / 4 GB / 8 GB），下面是说明文字（深色 `r62-01-cache-limit-dark.png`，浅色 `r62-02-cache-limit-light.png`） |
| 点了真的写进核心 | 点「512 MB」后 `<data>/cache-settings.json` 变为 `{"mediaLimitBytes":536870912}`；重启应用再进设置，卡片上选中的就是 **512.0 MB**（不是回落到默认） |
| 边界来自核心 | 卡片的档位区间与 `cacheStatus` 回的 `limitMinBytes`/`limitMaxBytes` 一致；越界值在核心侧被拒（Rust 测试与假宿主断言各一处） |

**边界如实记录**：上限只作用于**播放缓存**（歌词/详情与封面没有独立上限，按 LRU 与 TTL 管理）；
界面给的是固定档位，不做任意输入（避免手滑填 0 或 100 GB）；设置文件不随缓存清理删除，
但删数据目录会一起消失（等同恢复默认）。

## 已完成（第六十一轮）

### 1. 「不同第三方不同策略」：收藏夹选择（第 69 条命令）

R60 的 `catalog.favorites` 只能拿「源自己的默认收藏」——但第三方的收藏结构差别很大：
视频站是多个**收藏夹/媒体列表**、音乐站是多个**自建歌单**。所以这一轮把「选哪一个」补上：

| 层 | 新增 |
|---|---|
| ABI | 可选 `getFavoriteCollections()` → `[{id, title, count?}]`；`getFavorites(page, collectionId?)` 多一个参数（只实现默认列表的插件忽略它即可） |
| 命令 | `catalog.favoriteCollections{source}`（**69** 条命令）→ `{source, items}`；`catalog.favorites` 增加 `collectionId`，并把返回值里的 `collectionId` 原样带上 |
| 界面 | 源收藏面板：该源有**多份**收藏时才出现第二个选择器（含数量），选中即重取；单份收藏的源不打扰用户 |

关键取舍：

- **缺能力不是错误**：`favoriteCollections` 对「只有一份默认收藏」的源返回**空数组**（不是
  `not_implemented`）——否则每个普通源都会在界面上弹一次错误；
- **每家自己的取法留在插件**：应用只认 `id/title/count`，B 站怎么列出收藏夹、QQ 音乐怎么列出歌单，
  都是插件的事（ADR-0005 中立：应用不认识具体厂商）;
- 缺 `id` 的条目被丢弃（选中了也取不到内容），`count`/`mediaCount` 归一化成 `count`；
- 同样**不缓存**（收藏夹名字与数量随时会变）。

### 2. 顺手修掉一个「测试静默不跑」的真问题

`core/tests/catalog_detail.rs` 的 `broken_cache_entry_falls_back_to_the_plugin` 因为一行
`/// …#[test]` 写在了注释行尾，`#[test]` 被吞掉——**这个测试从来没有运行过**（cargo 只报
`never used` 的 warning，很容易当成噪声）。本轮补回 `#[test]`，核心单测从 237 变 240：
新增 2 项收藏夹测试 + 这 1 项**恢复运行**的缓存原子性测试。

### 3. 验证

`pnpm verify` 五道全绿：smoke **349/349**（+3：收藏夹列表带数量、选中收藏夹时把 `collectionId`
交给核心、只有一份默认收藏的源返回空列表）；契约 **69 命令 / 9 事件 / 26 错误码**；可达性
**163/72/145**；`cargo test -p gently-core` **240/240**。

**打包版实测**：测试插件实现 `getFavoriteCollections()` 返回两份收藏夹 → 「我的收藏 → 源收藏」
在源选择器下面多出**收藏夹选择器**（默认收藏夹 12 / 动画收藏夹），切到第二份后列表标题随之变化
（浅色 `r61-01-collections-light.png`；深色 `r61-02-collections-dark.png`，行标题随之变成 `[fav-anime] …`）。

**边界如实记录**：仍没有真实第三方源可测；收藏夹选择是**单选**（不做多选合并）；
「全部导入到本机收藏」仍未做。

## 已完成（第六十轮）

### 1. 核心：`catalog.favorites`（第 68 条命令）

- 参数 `{source, page?}`；源必须已启用、已加载、且**运行时探测到 `getFavorites`**：
  缺能力 → `common.not_implemented`（界面据此隐藏入口），未安装/已禁用 → `common.not_found`
  （与搜索一致「禁用立即生效」）。
- 返回 `{source, items, hasMore, nextPage?}`：`hasMore` 只认插件的 `isEnd === false`——
  **缺这个字段就当作没有下一页**（不猜「可能还有」）。
- **刻意不缓存**：榜单/推荐缓存 24 小时是合理的，收藏不是——用户随时会在别处取消收藏，
  缓存一分钟就可能显示一首已经不存在的收藏。测试用插件自己的调用计数钉住这一点。
- 登录由插件自己取（`@oauth` 插件的 `oauth.getAccessToken()`，cookie 类插件用清单声明的凭据）；
  核心不掺和具体源的鉴权（ADR-0005 / ADR-0008）。

### 2. 清单与沙箱

- `PluginCapability` 新增 `getFavorites`（清单预扫描、运行时探测、`CAPABILITY_NAMES`、
  bootstrap 的收集名单三处同步——少一处就会出现「插件明明写了，核心说没有」）。
- 契约 §5.2 记下 ABI 形状：`async function getFavorites(page)` → `Track[]` 或 `{isEnd, data}`。

### 3. 界面：「我的收藏」分两块

- 顶部两个 tab：**本机收藏**（本机库快照，插件卸载了也还在）/ **源收藏**（账号里、服务器上、
  需要登录、断网就没有）——不合并成一个列表，否则用户分不清「我的收藏」到底存在哪。
- 源收藏面板：只列出**已启用且实现了 `getFavorites`** 的源（读核心的插件摘要，不在前端乱猜）；
  按源切换、刷新、加载更多；行操作复用 `useTrackActions`（播放 / 收藏 / 下载）。
- 错误按码说清楚：`common.not_implemented`（这个源没有收藏夹）/ `source.auth_expired`（要登录）/
  其它上游失败；翻页失败**不清空**前一页数据（失败只提示，已有行保留）。
- 浏览器预览：没有核心 → 不出现任何源，只说明「没有已启用的音源提供收藏夹」，不拿演示数据冒充。

### 4. 验证与证据

`pnpm verify` 五道全绿：

- `pnpm typecheck` 通过；`pnpm smoke` **346/346**（+5：源收藏面板渲染、非核心源返回 null、
  分页形状带页码、末页没有下一页、缺能力时**如实带出 `common.not_implemented`**）；
- `pnpm check:contract` 一致（**68 命令 / 9 事件 / 26 错误码**）；
- `pnpm check:reachability` 通过（服务节点 161 / 动作节点 72 / 界面文件 145；有意留白 1 项）；
- `cargo test -p gently-core` **237/237**（+1 项集成测试，两个场景：归一化 + 分页 + **不缓存**的调用计数；
  能力缺失 / 未安装 / 已禁用的三种错误码）。

**打包版实测**（当前构建，`release/gently-0.1.0-windows-x64/gently.exe` + 本机模拟授权服务器）：

| 验什么 | 结果 |
|---|---|
| 真实数据来自插件 | 装一个实现 `getFavorites` 的测试插件并完成授权后，进「我的收藏 → 源收藏」：源列表里出现它，两行曲目、`加载更多`可用（`r60-06-source-favorites-dark.png`） |
| 令牌真的流到了插件 | 行标题由插件用**它自己读到的令牌**拼出：「收藏歌曲 1-1（已登录 token-demo-3）」——说明 `oauth.getAccessToken()` 在收藏调用里同样可用 |
| 深/浅主题都读得清 | 同一页面浅色下文字、tab、表格、说明都正常（`r60-07-source-favorites-light.png`） |
| 说明如实 | 底部常驻「源收藏来自插件（需要登录，登录方式由该源决定）；本机不缓存它，每次打开都会重新取」 |

**边界如实记录**：没有真实第三方源可测（需要一个实现 `getFavorites` 的第三方插件与账号）；
「导入到本机收藏」目前走每行的「收藏」动作（一条一条来），没有做「全部导入」；
源收藏**不缓存**，所以离线时它是空的——这是设计决定，不是缺陷。

## 已完成（第五十九轮）

### 1. 决策：ADR-0008 + 两个拍板

- `docs/adr/0008-oauth-plugin-declared-endpoints.md`：端点在**插件清单**里、流程在**核心**里；
  为什么不是内置某一家（ADR-0005 不允许，也无法覆盖各家差异）；边界写死——只支持公共客户端 +
  PKCE，不支持 client_secret / 远端注销 / scope 变更。
- `docs/adr/0007-…`：版本号**不提前提号**（已拍板）；新增 §1.1「主题控制面板：明确不做」。

### 2. 清单：`@oauth` 声明（第 5 处清单字段）

- 单文件头部：`@oauth authorize=<url>,token=<url>,client=<id>,scopes=<a b>,port=0,pkce`；
  目录包：`"oauth": {authorizeUrl, tokenUrl, clientId, scopes, pkce, redirectPort}`（归一化成同一形状，
  解析只有一份实现 `parse_oauth`）。
- 校验：三项必填；端点域名必须写进 `@hosts`、只允许 HTTPS（**本机回环 `http://127.0.0.1` 例外**）；
  声明即**自动补上** `network` + `credentials` 权限（否则作者漏写 `@permissions` 时授权会被权限检查拒掉）。
- 兼容模式插件（`compat`）**不认** `@oauth`：清单是从 `module.exports` 合成的，没有可信端点声明。

### 3. 核心：`core/src/oauth.rs`（新增，518 行）

| 部分 | 做法 |
|---|---|
| 回调 | `auth.begin` 绑 `127.0.0.1:0`，生成 `state` 与 PKCE verifier/challenge（S256）；后台线程非阻塞轮询，180s 上限；成功/取消/超时都释放端口与线程 |
| 校验 | `state` 不匹配 → 回 400 页面、**绝不换令牌**；`/callback` 只回一小段无外部资源的 HTML（「可以关闭此页面」） |
| 换令牌 | `POST application/x-www-form-urlencoded`（`grant_type=authorization_code` + `code_verifier`）；400/401 或缺 `access_token` → `source.auth_expired`，其它 → `source.upstream_failed` |
| 存储 | 只写 `CredentialStore`（Windows 凭据管理器，键 `__oauth_token`），日志只记「成功/失败 + 过期时间」 |
| 续期 | 过期且剩余不足 60s、且有 `refresh_token` → 取用时就地续期并写回；续不上按未登录处理 |
| 登记表 | 同插件同时只允许一轮授权；`finish` **按 `state` 收尾**（否则上一轮的线程会把新一轮的登记删掉——这个坑在写测试前先想到并加了断言） |
| 错误码 | 未声明 → `common.invalid_argument`；未安装 → `common.not_found`；端点域名不在白名单 → `plugin.permission_denied` |

### 4. 命令、事件与沙箱

- 新增 4 条命令（契约 63 → **67**）：`auth.status{pluginId}` / `auth.begin{pluginId}` /
  `auth.cancel{pluginId}` / `auth.signOut{pluginId}`；`auth.status` **只回状态**，
  含 `declared / authorized / expiresAt / scopes / declaredScopes / pending / backend`。
- 新增事件 `auth:changed{pluginId, authorized, expiresAt?}`（8 → **9** 个事件）：回调线程拿到令牌 /
  取消 / 失败时推一次，界面不必轮询。
- 沙箱新增 `oauth.getAccessToken()`（只有声明 `@oauth` 的插件有值）；`credentials.get('__…')`
  一律返回 `undefined`——`__` 前缀是宿主保留键，令牌就存在那里，插件只能走受控入口。

### 5. 界面：插件管理里的「第三方授权」卡片

- 只有清单声明了 `@oauth` 的插件才出现（没声明就没有登录这回事）；
- 显示已授权/未授权、声明的 scope、到期时间；按钮：授权 / 取消等待 / 退出登录（走 `useConfirm`）；
- 三条如实说明：授权页在**系统浏览器**里打开、端点来自插件、令牌只进系统凭据库；
  凭据库降级时改说「重启后要重新授权」；插件关掉 PKCE 时单独提示风险；
- 浏览器预览下按钮禁用并说明「需要桌面端本机核心」。

### 6. 验证与证据

`pnpm verify` 五道全绿：

- `pnpm typecheck` 通过；`pnpm smoke` **341/341**（+9：浏览器下状态为 null / 发起授权如实失败 /
  声明 `@oauth` 的插件出现入口（含 scope）/ 未声明则无入口；假宿主下 status/begin/cancel/signOut
  **四条命令的参数与命令名**、授权地址真的交给 `plugin:opener|open_url`、`auth:changed` 事件刷新状态）；
- `pnpm check:contract` 一致（**67 命令 / 9 事件 / 26 错误码**；命令域新增 `auth`，守卫的域前缀与
  服务层字面量扫描同步加上了它）；
- `pnpm check:reachability` 通过（服务节点 159 / 动作节点 72 / 界面文件 144；有意留白 1 项）；
- `cargo test -p gently-core` **236/236**（+16：`core/tests/oauth.rs` 6 项 + `oauth.rs` 单测 6 项 +
  清单 `@oauth` 4 项）。

**为什么测试里不连真实第三方**：`core/tests/oauth.rs` 用 `127.0.0.1` 上的模拟实现——
「浏览器」由测试进程直接对回调端口发 HTTP，令牌端点用假传输层。断言覆盖：完整链路（PKCE 参数、
`state`、换令牌请求体）、`state` 不匹配 → 400 且不落令牌、命令返回值**不含令牌字符串**、
沙箱里 `oauth.getAccessToken()` 有值而 `credentials.get('__oauth_token')` 为 `undefined`、
过期令牌用 refresh token 续期、未声明/未安装的显式报错。

**边界如实记录**：没有接任何真实第三方做端到端实测（那需要真实账号与凭据，且会违反第三方中立）；
机密客户端、远端注销、多账号并存都不支持；B 站收藏夹这类**具体源**能力仍需插件侧实现。

**打包版实测**（`release/gently-0.1.0-windows-x64/gently.exe` + 本机 `127.0.0.1:18765` 的模拟授权服务器）：
两个端点都是我临时写在本机的（校验 `client_id` / `state` / `redirect_uri`，
并按 `S256(code_verifier) === code_challenge` 校验 PKCE）；装进应用的是一个**只在头部声明了 `@oauth`** 的测试插件。

| 验什么 | 结果 |
|---|---|
| 安装前的告知 | 预览面板出现「第三方授权（安装后浏览器会打开这个域名的授权页）」+「授权域名：127.0.0.1:18765」+「授权范围：fav」（`r59-04-preview-oauth.png`） |
| 入口只在声明时出现 | 该行展开后是「第三方授权（OAuth 2.0，端点由该插件声明）」卡片：未授权 / 授权范围 / 授权按钮（`r59-06-auth-card.png`）；没有 `@oauth` 的插件不出现（冒烟断言） |
| 授权真的走浏览器 + 回调 | 点「授权」→ 系统浏览器打开授权页 → 302 回 `http://127.0.0.1:49982/callback` → 卡片变「已授权 · 授权范围 fav · 到期时间 2026/10/18 12:23:34」（`r59-07-authorized.png`） |
| PKCE / state 真的对 | 模拟服务器日志：`/authorize` 收到 `code_challenge=StzkV-…` + `code_challenge_method=S256` + `state=663bd3ac…`；`/token` 收到 `grant_type=authorization_code` + `code_verifier=252e7080…`，S256 校验通过才签发 |
| 令牌真的进了系统凭据库 | `cmdkey /list` 出现 `Target: LegacyGeneric:target=gently:oauth-probe:__oauth_token`（User = 插件 id） |
| 日志里没有令牌 | 只有 `第三方授权已开始…port=49982`、`第三方授权成功…expires_at/scopes=["fav"]`、`第三方授权已清除` |
| 退出登录 | 点「退出登录」→ 卡片回到未授权 + 按钮变回「授权」；`cmdkey /list` 里那条**消失**（`r59-08-signout-confirm.png`；该机器关闭了二次确认，所以没弹窗） |

交付物已重新打包：`release/gently-0.1.0-windows-x64.zip`（116.2 MB，内层 exe SHA256
`7e32fe9d9155639d1f169b942873ad9b295ce8aff7bad32d9a9290793bb32e2f`）。


### 7. 未完成项（如实登记，不冒充）

- 具体源的用户收藏夹（`getFavorites` 一类 ABI + 界面），B 站只是其中一个例子；
- 缓存上限用户自定义、下载逻辑收尾细节；
- 桌面歌词的位置记忆 / 点击穿透。

## 已完成（第五十八轮）

### 1. 版本规划（`docs/adr/0007-versioning-and-pet-extension.md`）

- **版本线**：`0.1.0` 为当前开发期；待完成项 1–6 全部验收、第 7 项有结论后发 **`1.0.0`**；
  1.x 只修 bug / 补文档 / 加不破坏契约的能力，**不加新的大功能**；pet 元素属于 **`2.0.0`**。
- **为什么先写 ADR 再写代码**：版本号一旦对外，退不回来；「pet 什么时候做」定不清楚，
  2.x 的接口就会在 1.x 里被临时改三次（R58 只预留接口，不实现宠物）。
- **本轮不动版本号**：`package.json` / `tauri.conf.json` / `Cargo.toml` 仍是 `0.1.0`——
  是否打 1.0.0 由用户拍板，ADR 里记的是方案而不是既定事实。
- `docs/ROADMAP.md` 同步加了 R54–R58 的进度与「2.5 1.x 收口与 2.x 桌面宠物（预留）」状态表。

### 2. pet 扩展点（`src/pet/`，无新契约命令）

只留接口，不加载任何资源（社区宠物将来按插件方式导入，仍走 `plugin.preview` → 用户同意）：

| 文件 | 职责 |
|---|---|
| `types.ts` | `PetDefinition`（id/version/name/渲染组件/可选 `onMount`）、`PetInstance`、`PetContext`（播放快照 + 宿主尺寸 + 只读 store 订阅）、`PetPlaybackSnapshot` |
| `registry.ts` | `registerPet` / `listPets` / `subscribePets` / `petsRevision` / `clearPets`；**同 id 覆盖**：旧 disposer 只移除自己那次注册，不得把新注册顶掉 |
| `context.ts` | `petPlaybackSnapshot(state)` 纯函数 + `createPetContext()`（只喂只读数据，宠物拿不到 action） |
| `PetHost.tsx` | 挂在 `App.tsx`；**没有宠物时渲染 `null`**（不占位、不留空壳、不发请求），有宠物时渲染进 `[data-pet-host]` |

- 冒烟断言覆盖：`PetHost` 无宠物时渲染 `null`、注册后出现容器、同 id 覆盖不重复、
  旧 disposer 不移除覆盖后的注册、注销后清空、只读快照只带当前曲目/播放态/歌词行/主题。

### 3. 下载：「在文件夹中显示」

- 下载完成列表每行新增「在文件夹中显示」，走 `fileService.revealInDir(task.path)` →
  核心既有的 `system.revealPath`（**不是新命令**，也不是 `shell.open` 任意路径）。
- 只在有本地路径的任务上出现（未完成/失败任务不显示，避免点出一片空白）。
- 中英文案齐（`page.download.reveal`）。

### 4. 验证与证据

`pnpm verify` 五道全绿：

- `pnpm typecheck` 通过；`pnpm smoke` **332/332**（+6，全部是 pet：`PetHost` 空态、注册后出现容器、
  同 id 覆盖不重复、旧注销不误删覆盖后的注册、注销后清空、只读快照含曲目/播放态/歌词行/主题；
  下载「在文件夹中显示」复用既有的 `fileService.revealInDir` 假宿主断言，未新增计数）；
- `pnpm check:contract` 一致（**63 命令** / 8 事件 / 26 错误码；pet 与下载动作都不新增契约）；
- `pnpm check:reachability` 通过（服务节点 153 / 动作节点 72 / 界面文件 **143**；有意留白 1 项）；
- `cargo test -p gently-core` **220/220**（本轮无 Rust 改动）。

**打包版实测**（`release/gently-0.1.0-windows-x64/gently.exe`）：

| 验什么 | 结果 |
|---|---|
| 下载入口 | 已下载任务（B 站曲目，10.6 MB）行上有「在文件夹中显示」（`r58-03-downloaded-reveal.png`） |
| 真的打开 | 点击后 Explorer 打开 `%APPDATA%\com.xun.gently\downloads` 并选中该文件（`r58-04-explorer.png`） |
| 无路径的任务 | 失败/未完成任务不显示该动作 |

**边界如实记录**：pet 只有接口与宿主，**没有任何内置宠物**、没有设置页入口、没有导入格式——
真正的宠物实现与导入留给 2.0；本轮没有新增主题控制面板（待拍板）。

交付物已重新打包：`release/gently-0.1.0-windows-x64.zip`（116.1 MB，内层 exe SHA256
`c28c029e1ef038e61bea1255f867451f4119b6545e16ce8d4663568b27021afd`）。

### 5. 未完成项（如实登记，不冒充）

- OAuth2 第三方授权与 B 站收藏夹访问（待完成项 6）；
- 主题控制面板（待拍板，待完成项 7）；
- 版本号是否改为 1.0.0（ADR-0007 已给方案，**待用户拍板**）；
- 缓存上限用户自定义、桌面歌词的位置记忆与点击穿透、下载逻辑的收尾细节。

## 已完成（第五十七轮）

### 1. 第二个窗口（`desktop-lyrics`）

- `tauri.conf.json` 新增窗口：无边框、置顶、跳过任务栏、`visible: false`、`focus: false`、
  `center: true`；URL 是 `index.html?window=desktop-lyrics`。
- `main.tsx` 读 query 决定挂载完整应用还是 `DesktopLyricsApp`——**构建产物只有一份**，不需要第二个
  HTML 入口；浏览器预览与主窗口都不受影响。
- `capabilities/default.json` 同时给两个窗口授权（`show` / `hide` / `set-position` /
  `set-focus` / `set-always-on-top` / `start-dragging` 等）。

### 2. 主窗口入口与窗口服务

- 工具栏新增「桌面歌词」按钮（`IconLyrics`，独立图标，`aria-pressed` 显示开启态）；
  浏览器预览下禁用（没有原生窗口）。
- `windowService` 新增 `desktopLyricsVisible` / `toggleDesktopLyrics` / `hideDesktopLyrics`：
  显示时把窗口摆到**屏幕底部居中**（每次显示都摆，避免「配置 center 与记住位置」一半一半）；
  隐藏/显示返回真实可见状态。
- 打开时查询一次可见性，窗口自己关掉时通过事件把按钮状态改回来。

### 3. 跨窗口同步（无新契约命令）

两个 WebView 各有独立 JS 堆，store 不共享。用**窗口间事件**同步：

| 事件 | 方向 | 载荷 |
|---|---|---|
| `gently:lyrics:update` | 主窗口 → 歌词窗口 | `{title, artist, line, next, translation?, playing, empty, source, themeMode}` |
| `gently:lyrics:closed` | 歌词窗口 → 主窗口 | 无（主窗口把按钮恢复为未按下） |

- 行 / 曲目 / 播放态变化时立即推一次；另有 1s 心跳兜底（窗口刚打开、暂停后也能拿到当前状态）。
- 高亮行复用 `activeLyricIndex`（与歌词页同一份实现），时间轴偏移照常生效。
- 主题模式随载荷同步：独立 WebView 不会自动跟随主窗口切主题，歌词窗口收到后调用 `setMode`。

### 4. 歌词窗口本身

- 当前行大字号 + 译文 + 下一行（弱化），曲目与歌词来源分别在左下/右下；
- `A−` / `A+` 调字号（0.8~1.8，按窗口 localStorage 记住；字号以主题 token 为基准缩放，
  不把像素值写进组件）；`×` 隐藏窗口并通知主窗口；
- 整窗 `data-tauri-drag-region="deep"` 可拖动（按钮阻断拖动）。

### 5. 验证与证据

`pnpm verify` 五道全绿：

- `pnpm typecheck` 通过；`pnpm smoke` **326/326**（+4：桌面歌词载荷的当前行/下一行/译文/来源、
  偏移参与高亮、播放条按钮有独立入口、无窗口时歌词组件可渲染空态）；
- `pnpm check:contract` 一致（63 命令 / 8 事件 / 26 错误码；桌面歌词是窗口间事件，不新增契约事件）；
- `pnpm check:reachability` 通过（服务节点 153 / 动作节点 72 / 界面文件 138；有意留白 1 项）；
- `cargo test -p gently-core` **220/220**（本轮无 Rust 改动）。

**打包版实测**（`src-tauri/target/release/gently.exe`；第二个窗口用 Win32 `PrintWindow` 单独截）：

| 验什么 | 结果 |
|---|---|
| 开关与位置 | 播放真实 NetEase 曲目（有歌词）→ 点工具栏「桌面歌词」→ 760×160 窗口出现在屏幕底部居中（`r57-04-main-open.png` / 浅色窗口 `r57-11-lyrics-light.png`） |
| 内容 | 当前行「编曲：Beyond/梁邦彦」+ 下一行「今天我 寒夜里看雪飘过」+ 曲目「海阔天空 · Beyond」+ 来源「网易云（本地歌词测试）」（`r57-11-lyrics-light.png`） |
| 字号 | 连点 `A+` 两次 → 主行明显变大（`r57-06-lyrics-bigger.png`） |
| 关闭 | 点 `×` → 窗口 `IsWindowVisible=false`；主窗口按钮恢复未按下（`r57-07-main-after-close.png` 与打开态 `r57-04-main-open.png` 对比） |
| 主题同步 | 窗口开着时切主窗口明暗 → 歌词窗口跟着变（深色 `r57-12-lyrics-dark.png` / 浅色 `r57-11-lyrics-light.png`） |
| 无歌词场景 | 播 B 站曲目（源不提供歌词）→ 窗口显示「暂无歌词」，曲目信息仍显示（`r57-13-lyrics-empty.png`） |

**边界如实记录**：桌面歌词窗口**没有**做点击穿透 / 锁定、也不支持在窗口里切歌（这些交互放主窗口）；
窗口位置每次显示都回到屏幕底部居中，不记忆用户拖动后的位置；多显示器只按主窗口所在显示器摆放。

交付物已重新打包：`release/gently-0.1.0-windows-x64.zip`（116.1 MB，内层 exe SHA256
`cbcd3668093badd4039521ad159c6c301323d27f549f7d49f39bac5d88f3c22a`）。

### 6. 未完成项（如实登记，不冒充）

- 下载相关逻辑的剩余部分；
- 1.x/2.x 版本规划与 pet 接口预留（待完成项 5）；
- OAuth2 第三方授权与 B 站收藏夹访问（待完成项 6）；
- 主题控制面板（待拍板，待完成项 7）。

## 已完成（第五十六轮）

### 1. 核心：播放缓存（`core/src/cache.rs`）

- `playback.resolve` 成功解析后调 `cache::spawn_fill(...)`：后台线程用 `HttpTransport::download`
  流式写 `.part`，完成后原子 rename；同时写 `<file>.json` 元信息
  （`reference / quality / source / bytes / at`）。
- **键**：`sha256(reference|quality)` 前 32 位 → `cache/media/<key>.<ext>`；扩展名取自媒体地址
  （未知按 `m4a`），保证回环代理按扩展名给出正确的 `Content-Type`。
- **只缓存播放过的**：没有预取、没有后台扫曲库；`once` 语义由 `CacheRegistry` 保证
  （同一键不重复补全，最多同时 2 个补全线程）。
- **限额**：单文件 256 MiB（超大不缓存）、媒体总量 1 GiB；超过后按 sidecar 的 `at` 从旧到新删。
- **失败不影响播放**：任何下载/写盘错误只记 `tracing::debug`，并把半截 `.part` 清掉
  （第一版漏了这一点，实测留下一个 0 字节残骸，已修）。

### 2. 核心：缓存优先（离线可播）

`playback.resolve` 现在在**调用插件之前**先查缓存：

- 先精确匹配 `reference + quality`，再退到「同一 reference 的任意音质」（离线兜底）；
- 命中的文件直接 `publish_local` 到**同一条回环代理**，响应带 `fromCache: true`；
- 因此断网、插件被停用、甚至插件被卸载时，已缓存的那首仍能播；
- 顺带修掉一个真 bug：`playback.resolve` 之前**不看插件启停状态**（停用后仍会解析），
  现在与搜索一致「禁用立即生效」；缓存分支在检查之前，离线不受影响。

### 3. 核心：歌词缓存可离线

- 歌词 TTL 从 6 小时提到 **30 天**（`LYRICS_TTL_SEC`）；歌词几乎不变，而它是离线体验的一部分。
- `catalog_detail::call_detail` 改为**先读缓存、再检查插件能力/启用状态**：没有插件也能返回缓存
  里的歌词/详情；没有缓存时才走原来的 `not_implemented` / `not_found` 语义。
- `catalog.lyricsSearch` 写入的歌词缓存同样用 30 天 TTL。

### 4. 命令与契约

- 新增 `system.cacheStatus` → `{mediaBytes, mediaCount, catalogBytes, catalogCount, coversBytes,
  coversCount, limitBytes}`；
- 新增 `system.cacheClear{kind?}`（`media` / `catalog` / `covers` / `all`）→
  `{removedBytes, removedFiles}`；未知 kind → `common.invalid_argument`；
- 契约命令数 61 → **63**，文档（§2 system 表、§9.1 缓存布局与策略、§7 播放语义）与
  `src/api` / `services` / 守卫同步。

### 5. 设置页缓存卡片

- 显示「播放缓存 / 歌词与详情 / 内嵌封面」三块的体积与文件数，以及上限（1.00 GB）；
- 三个操作：清理播放缓存、清理歌词与详情、全部清理（`useConfirm` 二次确认）；
- 清理后重新读一次状态并提示「已清理 N 个文件（X MB）」；
- 浏览器预览如实显示「缓存管理需要桌面端本机核心」，不发任何请求。

### 6. 验证与证据

`pnpm verify` 五道全绿：

- `pnpm typecheck` 通过；`pnpm smoke` **322/322**（+3：浏览器下缓存状态是 `unsupported_platform`；
  假宿主下状态按三类统计、清理带 `kind` 并回统计）；
- `pnpm check:contract` 一致（**63 命令** / 8 事件 / 26 错误码）；
- `pnpm check:reachability` 通过（服务节点 147 / 动作节点 71 / 界面文件 134；有意留白 1 项）；
- `cargo test -p gently-core` **220/220**（+1：`played_tracks_are_cached_and_playable_when_the_source_is_gone`
  —— 播放 → 等待后台补全 → 停用插件 → 仍能 `fromCache: true` 通过回环代理播放 → 清理后返回 `null`）。

**打包版实测**（`src-tauri/target/release/gently.exe`，1296×809）：

| 验什么 | 结果 |
|---|---|
| 播放过的曲目真的缓存了 | 播放排行榜第一首（真实 B 站源），`<data>/cache/media/` 出现 `1dd75d….m4s`（**11,130,879 字节**）+ sidecar（`quality=high`、`source=bili-audio`） |
| 设置页能看见 | 缓存卡片：播放缓存 **10.6 MB · 1 个文件**、歌词与详情 243 KB · 20 个文件、上限 1.00 GB（`r56-08-cache-card.png`） |
| 能清理 | 点「清理播放缓存」→ 播放缓存变 **0 KB · 0 个文件**，提示「已清理 2 个文件（10.6 MB）」（`r56-09-clear-confirm.png`；该机器关闭了二次确认，所以没弹窗） |
| 浅色主题 | 同一卡片浅色下可读（`r56-10-cache-light.png`） |

交付物已用当前源码重新打包：`release/gently-0.1.0-windows-x64.zip`（116.1 MB，内层 exe SHA256
`30250cff085e1d1e1754ac74dc3fd8b6a02f5b845044443f7b40ce7bffb760e4`）。

**如实记下的边界**：

- 打包版没有真的拔网线；「断网仍能播」由 Rust 集成测试用「停用插件」模拟源不可用来覆盖
  （缓存命中在插件检查之前，逻辑上等价），没有把「能点开设置页」当成离线验收。
- NetEase 的 `song/media/outer/url` 会 302 到 `http://` 或 404，缓存补全会失败并只记 debug 日志；
  这属于源侧地址不可用，不是缓存 bug（B 站源正常缓存）。
- 缓存上限暂为固定 1 GiB（核心常量），设置页只展示与清理；「用户自定义上限」留待后续。

### 7. 未完成项（如实登记，不冒充）

- 下载相关逻辑的剩余部分（目录/音质/缺档策略/并发上限已完成）；
- 桌面歌词（待完成项 4）；
- 1.x/2.x 版本规划与 pet 接口预留（待完成项 5）；
- OAuth2 第三方授权与 B 站收藏夹访问（待完成项 6）；
- 主题控制面板（待拍板，待完成项 7）。

## 已完成（第五十五轮）

### 1. 核心：`catalog.lyricsSearch`（第 61 条命令）

为什么必须新增命令而不是前端拼：跨源搜索 + 每源挑候选 + 取词 + 缓存 + 超时控制是**数据处理**，
按 AGENTS 第 15 条归核心；前端只渲染结果。

实现要点（`core/src/catalog_detail.rs`）：

- **目标源**：已启用、已加载、同时有 `search` + `getLyric`。只有 `search` 的源放进
  `skippedSources`（不参与、也不算失败）；加载失败的源进 `failedSources`；
- **每源一个线程**：先 `search(query, 1)`，取前 `limit`（1~5，缺省 2）个归一化条目逐个
  取词；单条无词/插件抛错只跳过该条，**不让整源失败**；
- **整体 12s 截止**：慢源放 `timedOutSources`，已经拿到的结果照常返回（不阻塞整页）；
- **结果顺序按源优先级**，不是按谁先返回——否则每次搜索顺序都不一样；
- 歌词结果与 `catalog.lyrics` **共用缓存键** `lyrics:<source>:<rawId>:false`（6h），
  同一首歌重复搜索不会重复请求上游；
- 复用 `normalize_track` / `list_items` / `detail_item_arg`，兼容 MusicFree 的条目对象形状。

测试（`core/tests/catalog_detail.rs`）：两首歌有词、第三首无词被跳过；`sourceName` 与
`track.id` 正确；只有 `search` 的源进 `skippedSources`；第二次搜索不再调插件的 `getLyric`
（缓存命中）；空关键词返回 `common.invalid_argument`。

### 2. 歌词页：搜索面板 + 来源展示

`views/now-playing/index.tsx`：

- 标题行右侧显示当前歌词来源（自动匹配 = 曲目自身的源；手动选择 = 那份结果的源 + 标题），
  以及「搜索歌词」开关；
- 面板预填 `当前标题 + 艺术家`，回车/点「搜索」触发；展示统计
  「N 个源返回 · M 份歌词 · K 个源不提供歌词 · T 个源超时」；
- 每条结果显示来源徽标、曲目标题、歌手与首行歌词——用户能判断这份词是不是自己要的；
- 点「使用」→ `player.applyLyrics(lines, source)`，面板收起并给出「已使用…」提示；
- 浏览器预览（无核心）显示「搜索歌词需要桌面端本机核心」，不假装有结果。

### 3. 时间轴校正（按曲目持久化）

- `utils/lyricsOffset.ts`：`readLyricsOffset` / `writeLyricsOffset`（localStorage，上限 ±30s、
  500 首、写 0 等于删除）；`clampLyricsOffset` 保留 1 位小数；
- 播放切片新增 `lyricsSource` / `lyricsOffset`，`start()` 时读回该曲目的偏移、重置为自动来源；
  `setLyricsOffset` 写回；`applyLyrics` 用 `playId` 防止**迟到的自动歌词**覆盖用户选择；
- 渲染：`Lyrics elapsed={elapsed + offset}`；点某行时 `seek(line.time - offset)`——
  偏移的正负号只在这两处解释；
- 校验：冒烟断言「自动歌词带来源」「手动歌词不被迟到结果覆盖」「偏移可设置/被钳到上限/
  切歌读回」。

### 4. 真实链路实测（打包版）

用用户放在 `examples/wangyiyun.js` 的那份社区插件里的接口做了一份**依赖清零**的本地测试插件
`release/plugins/wangyiyun.js`（`release/` 被 git 忽略，不进仓库）：

- 那份原文件是 MusicFree CommonJS 插件，依赖 `axios` / `crypto-js(AES)` / `big-integer` /
  `qs` / `cheerio`（weapi 加密链路），我们的沙箱只有 `fetch` + `axios/crypto-js(部分)/dayjs/he`
  垫片，**直接导入会因不支持的模块失败**；因此只保留「免加密接口」的 search / lyric /
  outer-url 三件事用于验证产品链路（`plugin-tool check` 通过）。

实测（`src-tauri/target/release/gently.exe`，1296×809）：

| 验什么 | 结果 |
|---|---|
| 搜索歌词面板 | 打开后预填「回村三天… 衣戈猜想」；浅色主题可读（`r55-02-search-panel.png`） |
| 没有源提供歌词时 | 0 个源返回 · 0 份歌词 · **2 个源不提供歌词** + 空态提示（`r55-03-search-results.png`） |
| 真实歌词搜索 | 播放 NetEase 搜索结果第一行（封面/源都正确）→ 搜索歌词：**1 个源返回 · 2 份歌词**，两条都带来源徽标「网易云（本地歌词测试）」、标题、歌手与首行「作词：黄家驹」（`r55-11-lyrics-search-results.png`） |
| 使用 | 点「使用」→ 面板收起、提示「已使用「海阔天空」的歌词」、歌词列表高亮当前行、来源行更新（`r55-12-lyrics-applied.png`） |
| 时间轴校正 | 连点 `+0.5s` 两次 → `+1.0 秒`，高亮行随偏移移动（`r55-17-lyrics-offset-applied.png`） |
| 按曲目持久化 | 重启应用、重新播放同一首 → 偏移仍是 `+1.0 秒`（`r55-18-offset-persisted.png`） |
| 深色主题 | 同一页深色下可读（`r55-19-lyrics-dark.png`） |

交付物已用当前源码重新打包：`release/gently-0.1.0-windows-x64.zip`（116.1 MB，内层 exe SHA256
`25f66e529386830df4499e1d068394f8f20f99ce4623b8ea5374c2a20a149043`）。

### 5. 验证

`pnpm verify` 五道全绿：

- `pnpm typecheck` 通过；`pnpm smoke` **319/319**（+7：歌词搜索门面、来源/偏移状态、手动歌词
  不被覆盖、浏览器空态、假宿主 `catalog.lyricsSearch`）；
- `pnpm check:contract` 一致（**61 命令** / 8 事件 / 26 错误码）；
- `pnpm check:reachability` 通过（服务节点 145 / 动作节点 71 / 界面 134；有意留白 1 项）；
- `cargo test -p gently-core` **219/219**（+1 歌词搜索集成测试）。

### 6. 未完成项（如实登记，不冒充）

- 缓存：歌曲/歌词本地缓存、设置页缓存管理（待完成项 2）；
- 下载相关逻辑的剩余部分（本轮之前已完成目录/音质/缺档策略/并发上限）；
- 桌面歌词（待完成项 4）；
- 1.x/2.x 版本规划与 pet 接口预留（待完成项 5）；
- OAuth2 第三方授权与 B 站收藏夹访问（待完成项 6）；
- 主题控制面板（待拍板，待完成项 7）。

## 已完成（第五十四轮）

### 1. 最大化 / 向下还原必须是两个图标（bug ①）

根因：`Toolbar` 的窗口按钮只接 `windowControlsEnabled`，从来没有读「窗口现在是不是最大化」；
`windowService` 也只有 *做*（minimize/toggle/close），没有 *问* 的能力。于是两个状态共用
`IconMaximize`，用户只能靠「点一下猜」判断。

修法：

- 新增 `IconRestore`（双窗格，与最大化明显不同）；
- `windowService.isMaximized()`（浏览器恒为 `false`）与 `windowService.onResized()`（订阅窗口尺寸变化，
  浏览器返回空退订函数）；
- `TitleBar` 挂载时同步一次，并在 resize 时再同步——**双击无边框窗口的拖动区最大化**也走的是尺寸变化，
  因此按钮上的图标跟着变，不是只有点按钮那一条路；
- `Toolbar` 新增 `maximized` 属性：图标与 `title`/`aria-label` 一起切到 `toolbar.restore`（zh/en 成对）。

### 2. 歌词页返回要点 N 次（bug ②）

根因：播放条在**所有页面**都可见（`App.tsx` 的 `TMBLayout.bottom`），歌词页里也一样；
点封面 / 标题每次都 `navigate('/now-playing')`，在歌词页里每点一次就往历史栈压一条**重复**记录。
用户点 N 次就要点 N 次「返回」。

修法：

- 纯函数 `shouldOpenNowPlaying(pathname)`：已经在 `/now-playing` 时返回 `false`，播放条不再压栈；
- 歌词页「返回」在历史栈底（直接打开 / 刷新页面）时回首页，而不是 `navigate(-1)` 把用户丢出应用；
- 冒烟钉住该纯函数，避免以后有人把守卫删掉。

### 3. `decorations: false` 时窗口拖不动（bug ③）

根因：`tauri.conf.json` 里是无边框窗口（`decorations: false`），而标题栏只是一个普通 `<header>`，
**没有任何拖动区**。Tauri 的拖动由注入脚本按 `mousedown` 路径判定，必须显式声明。

修法：

- `TitleBar` 的根节点加 `data-tauri-drag-region="deep"`。Tauri 的判定规则是「路径上第一个可点击元素阻断拖动」，
  因此搜索框、工具栏按钮、输入框照常可点；空白处与 Logo 才是拖动区；
- 双击拖动区最大化依赖 `internal_toggle_maximize`（已在 `core:window:default` 里），
  但 `start_dragging` **不在默认集**里——capabilities 补 `core:window:allow-start-dragging`；
  没有这一条，属性挂上了也只会静默失败（命令被 ACL 拒掉）。

### 4. 设置页下载功能（bug 清单之外的待完成项 3 之一）

原来那张卡片是写死的 `example path` / `3` /「超高音质」，没有任何行为；i18n 里
`lowQuality`/`standardQuality`/`highQuality`/`superQuality`/`downloadHigherQualityVersion` 等键没人引用，
被死键守卫当场拦下。这一轮把它做成**真设置**（全部走 `ui` 切片 + localStorage 持久化）：

| 设置项 | 落在哪 | 行为 |
|---|---|---|
| 下载目录 | `ui.downloadDir` → `download.create.dir` | 留空 = 核心默认目录（`<data>/downloads`）；填了不存在的目录，核心会以 `common.invalid_argument` 明确拒绝，任务上带原因 |
| 默认下载音质 | `ui.downloadQuality` → `download.create.quality` | 从曲目自带的候选档位里挑 |
| 音质缺失时 | `ui.downloadQualityFallback`（`lower`/`higher`） | 纯函数 `pickQualityWithFallback`：方向优先，该方向没有档位就退另一边，来源没说档位就保留首选 |
| 最多同时下载歌曲数 | `ui.downloadMaxConcurrent`（1~4） | store 队列：`add` 只入队 + 插占位项，`pump()` 按槽位发命令；`running` 记账，完成/失败/暂停/移除都释放槽位；「继续」也排队，连点不会绕过上限 |

音质文案复用既有的 `quality.*` 键（删掉那 3 个重复的 `lowQuality/standardQuality/highQuality`），
避免同一件事两份翻译。默认值放在 `appConfig.download`（行为配置，不进主题）。

### 5. 验证与证据

`pnpm verify` 五道全绿：

- `pnpm typecheck` 通过；`pnpm smoke` **312/312**（+13：窗口拖动区/最大化文案/歌词页不重复压栈、
  下载设置默认值与越界钳制、`pickQualityWithFallback` 5 条、假宿主下「目录+缺档音质真的进了
  `download.create`」「并发上限只放行一首」「前一首完成后排队的下一首自动开始」）；
- `pnpm check:contract` 一致（60 命令 / 8 事件 / 26 错误码）；
- `pnpm check:reachability` 通过（服务节点 143 / 动作节点 69 / 界面 133，有意留白 1 项）；
- `cargo test -p gently-core` **218/218**（本轮无 Rust 改动）。

**打包版实测（`src-tauri/target/release/gently.exe`，`decorations: false`，默认窗口 1296×809）**：

| 验什么 | 操作 | 结果 |
|---|---|---|
| 最大化 / 向下还原是两个图标（bug ①） | 标题栏最大化按钮 (1221,30) → 截图 → 在新窗口按还原 (1862,30) | 还原态是**单方框**（`r54-00-restored.png`），最大化后是**双窗格**（`r54-02-maximized.png`，放大图与 ALT 文案变化一致）；点还原后窗口回到 1296×809（`r54-03-restored-after.png`） |
| 无边框窗口能拖（bug ③） | 在标题栏空白处 (250,30) 按住拖到 (+200,+120) | `GetWindowRect` 从 `26,26,1322,835` 变为 `226,146,1522,955`：**Δ=200,120**，窗口跟着鼠标走 |
| 歌词页返回一次就够（bug ②） | 播放第一行 → 点封面进歌词页 → **再点封面 3 次** → 点「返回」1 次 | 点完 3 次仍在歌词页（`r54-06a-still-lyrics.png`）；**返回 1 次**就回到排行榜（`r54-06b-back-once.png`，曲目仍在播、行 1 有播放标记） |
| 下载设置是真的（待完成项 3） | 设置页滚到「下载」卡片；在目录框粘贴 `D:\Music` → 重启应用 | 深/浅色两种主题下都能读（`r54-07-settings-download.png` / `r54-08-settings-download-light.png`）；输入框可编辑（`r54-09-download-dir-typed.png`），**重启后仍是 `D:\Music`**（`r54-10-download-dir-persisted.png`），说明持久化生效；测完清空（`r54-11-download-dir-cleared2.png`） |

交付物已用当前源码重新打包：`release/gently-0.1.0-windows-x64.zip`（116.0 MB，内层 exe SHA256
`ad40dadfadb59789ce45fa0d4814e1c640858c422e55d52e99472f33599730d9`）。

### 6. 未完成项（如实登记，不冒充）

- 歌词相关：搜索歌词、来源展示、时间轴手动校正（待完成项 1）；
- 缓存：歌曲/歌词本地缓存、设置页缓存管理（待完成项 2）；
- 桌面歌词（待完成项 4）；
- 1.x/2.x 版本规划与 pet 接口预留（待完成项 5）；
- OAuth2 第三方授权与 B 站收藏夹访问（待完成项 6）；
- 主题控制面板（待拍板，待完成项 7）。

## 已完成（第五十三轮）

### 0. 四个 bug 的根因与修法（一句话版）

| # | 根因 | 修法 | 证据 |
|---|---|---|---|
| ① | 扫描白名单只有 `mp3/flac/m4a/mp4/aac/ogg/oga/opus/wav`——**没有 `.m4s`**（B 站下载的音频就是这个后缀，ISO-MP4 容器），而 `D:\Xun\Music` 里正好只有它 | 补 `m4s`/`m4b`/`m4r`（同一个容器，symphonia 的 `isomp4` 一视同仁）；新增 `ignored` 计数（**非音频文件数**），让「有文件但都不是音频」不再和「目录是空的」显示成同一句话 | 单测 `m4s_container_is_indexed_like_any_other_audio_file`（真 `.m4s` 夹具入库、`unreadable=0`、`ignored=2`）+ 打包版扫描 `scanned=1 added=1`（`r53-02-local-scan.png`） |
| ② | 表格列宽**下限合计 832px** ＞ 最小窗口的内容区（900 宽 → 612），且窗口**没有默认宽度**（Tauri 默认 800 被 `minWidth 900` 顶到 900）；播放条 `@media (max-width: 900px)` 又把右侧整组控件（音源/音质/循环/队列/抽屉）**整块 `display:none`** | 列下限收到 **610**（`36+124+80+80+72+80+138`，含单元格左右各 18px 内边距）；播放条窄窗只收音量与秒数、**右侧按钮永不隐藏**；`tauri.conf.json` 给默认窗口 `1280×800`（`minWidth 900` / `minHeight 600` 不变） | 900/1280/1500 三档实图对比（`r53-03-window-900.png` / `r53-11-dark.png`） |
| ③ | 宿主把**字符串 id** 交给 MusicFree 的详情函数，而它们收的是**条目对象**：`getTopListDetail(topListItem)` 里 `topListItem.id` 是 `undefined` → URL 拼成 `.../x/web-interface/undefined` → 上游 **404**；`getMediaSource(musicItem)` 拿不到 `bvid`/`aid`/`cid` → 拼出 undefined → `plugin.runtime_error`（「能搜、能看榜单，一播就挂」） | 核心归一化时留下**插件原始条目的进程内快照**（LRU、不落盘、不上报），详情/播放解析对**兼容插件**把这份条目原样交回，无快照退化成 `{id}`；沙箱侧再把字符串包成 `{id}` 兜一层；**自有 ABI 仍只收字符串 id** | 单测 `compat_detail_calls_get_the_musicfree_argument_shape`、`our_own_abi_still_receives_plain_string_ids_in_compat_mode`、`playback_resolve_hands_the_plugin_its_own_raw_item`、`compat_detail_calls_receive_the_remembered_item_object`；打包版用**用户那份真实插件**跑排行榜拿到真实数据（`r53-05-compat-ranking.png`） |
| ④ | 三个假音源（`mock`/`bilibili`/`netease`）**无条件**注册，且 `loadPlugins()` 把「核心那份 + 演示源 + `qqmusic`/`kugou` 占位」合并返回 | 见下面 §1–§5：桌面端只认核心，演示数据一律只在无宿主（浏览器预览）时出现 | `pnpm smoke` 的假宿主断言 + 打包版音源筛选里只有核心插件（`r53-06-sources.png`） |

### 0.5 由真实插件需求倒逼出来的插件（交付附件）

按用户给的那份真实 MusicFree 插件移植出**单文件 ABI** 版本 `release/plugins/bili-audio.js`：
依赖清零（只用宿主注入的 `fetch`）、权限收成 `@hosts api.bilibili.com` 声明式白名单、
曲目引用自带播放定位信息（`id = <bvid>|<cid>`）。
`plugin-tool check` 静态校验通过（6 项能力），并用注入 `fetch` 的方式对真实接口逐条自测：
搜索 20 条、曲目详情、DASH 播放地址（`audio/mp4` + referer）、合集详情、榜单树（入站必刷 + 14 个分类）、
榜单内容 96/98 条。**过程里三个真教训**（都写进了文件头注释）：cookie 只按需要带
（`playurl` 带上指纹 cookie 反而 412）、榜单封面 `http→https`（否则被当混合内容挡掉）、
「每周必看」近期期数回 `-352` 风控（要 WBI 签名）→ 干脆不给这个入口。
交付位置：`release/plugins/`（`release/` 整个被 git 忽略，因此**不违反第 16 条**：
仓库代码与文档里不出现第三方音源地址），附 `README.md` 说明导入与边界。

### 1. 演示源只在没有 Tauri 宿主时注册（且不进桌面端主包）

`src/plugins/index.ts` 原来**无条件**注册 `mock` / `bilibili` / `netease` 三个假音源，
数据来自 `src/mock/**`，其中还捆着一份 4.4MB 随包音频当「可播放地址」。
现在模块顶层判定宿主（`'__TAURI_INTERNALS__' in window`，与 `window.service.isTauri()` 同一条件），
**只有没有宿主时**才用动态 `import('./builtin/demo-sources')` 注册：
Vite 因此把它摇成独立 chunk，桌面端主包不再包含 mock 链。

### 2. 服务层：核心在时一律不退回 mock

| 位置 | 新行为 |
|---|---|
| `libraryService.loadPlugins()` | 核心在 → **只回核心那一份**（不再合并演示源与 `qqmusic`/`kugou` 占位）；核心读失败 → 返回 `[]` 并 `console.warn` 原因 |
| `recommendService.suggest()` | 核心在且 `recommend.home` 无结果 → **空 bundle**（同形：空画像 + 三个空数组），视图照常显示「多听几首再来」 |
| `catalogService.fetchAlbum` / `fetchCuratedPlaylist` | `findAlbum` / `findCuratedPlaylist` 只在 `!coreAvailable()` 时兜底 |
| `catalogService.searchAll` | 前端演示源只在 `demoSourcesEnabled && !coreAvailable()` 时并入 |
| `catalogService.searchIn` | 没有可用源 id 时返回 `[]`（不再退回 `getActiveMusicSource()`） |
| `catalogService.defaultSourceId()` | 返回 `string \| null`，**不再抛异常**；调用方（`fetchTopLists` / `fetchRecommendFrom` / 榜单切片 / 推荐切片）给诚实的空态 |

### 3. 不再在渲染期抛异常（设置页白屏）

`getActiveMusicSource()` 以前在注册表为空时 `throw`，而设置页在**渲染期**调用它——
应用没有错误边界，桌面上「一个音源都没装」会直接白屏。
现在返回 `MusicSourcePlugin | undefined`，视图改经新的 `catalogService.activeSource(list)`
（服务层访问器，符合 AGENTS 第 5 条）拿 `PluginInfo | null`，为空时显示既有的
`page.plugin.empty`（「还没有安装任何插件」）。

### 4. 其余「只在浏览器预览」的假数据

- 标题栏热搜词：`hotWords={coreAvailable() ? [] : HOT_SEARCH_WORDS}`；
- 插件切片：`patch + 1` 的假版本号只在 `!coreAvailable()` 时出现（核心在且没有可比对来源时什么都不做）；
- 下载切片：核心拒绝建任务时**不编造** `totalMb` / `sizeText`（`0` / 空串），核心持有的任务不再预写 `1.0Mb/s` 假速度；
- 搜索页：桌面上一个音源都没装时不再说「没有找到相关歌曲」，改用新增的
  `page.search.noSource`（zh/en 成对）+ 既有的 `page.ranking.noGroupsHint`；
- `page.plugin.installedEmpty` 不再提「内置示例源见下方列表」（桌面上没有这份列表了）。

### 5. `GRADIENTS` 搬出 mock

`src/utils/helpers.ts` 原来静态依赖 `src/mock/base.data.mock.ts`（纯配色占位，不是 mock 数据）。
常量本体移到 `src/utils/gradients.ts`，`base.data.mock.ts` 转出一次保持既有引用不变。

### 6. 详细说明：扫描白名单与「非音频」计数（bug ①）

用户的现象是 `D:\Xun\Music` 里明明有文件却 `scanned=0`，界面只有「还没有本地音乐」。
实测那个目录里是 `yihuik苡慧 - 致你.m4s`（仓库里同一份文件就是播放链路夹具）——`.m4s` 是
**ISO-MP4 容器**，与 `.m4a`/`.mp4` 同族，symphonia 的 `isomp4` 本来就能读，只是白名单漏了它。
两处收口：

- `AUDIO_EXTENSIONS` 补 `m4s`/`m4b`/`m4r`（同一个容器；只列这个构建真能解码的——
  `wma`/`ape`/`aiff` 没开对应 feature，列进来只会把「读不了」的数字抬高）；
- 扫描结果新增 **`ignored`**（见到了但不是音频扩展名的文件数），界面文案变成
  「…跳过 N，读不了 N，**非音频文件 N**」：`scanned=0` 与「目录是空的」从此能分辨。

契约 §5「本机库语义」、`src/api/index.ts` 的 `ScanSummary`、zh/en 文案同步更新；
单测新增 `.m4s` 入库用例（顺带钉住 `ignored` 计数），冒烟新增一条断言。

### 7. 详细说明：兼容插件的参数形状（bug ③）

`docs/contracts/local-core-api.md` §5.4 现在把这件事写成**第三处兼容适配**（前两处是
`require(x).default` 与函数名别名）：MusicFree 的详情/播放函数收**条目对象**，我们只有 `source:rawId`。
两层配合，自有 ABI 仍只收字符串 id：

- 核心：`catalog::ItemSnapshots`（LRU 2000 条、进程内、不落盘）在归一化时按 `source:rawId`
  记下插件原始条目；`catalog_detail::detail_item_arg()` 对兼容插件把条目原样交回
  （`getTrackInfo`/`getAlbumInfo`/`getPlaylistInfo`/`getTopList`/`getLyric`），
  `playback.resolve` 则对**所有**源优先用快照（其次前端快照，最后 `{id, source}`）；
- 沙箱：`sandbox/bootstrap.js` 里别名函数（以及兼容模式下的 `getAlbumInfo`）把字符串包成 `{id}`，
  并新增 `env.compat` 标记（宿主在 `__hostEnvInfo` 里传）。

为什么必须有：不这么做，真实插件「能搜、能看榜单，一播就 `plugin.runtime_error`」——
插件把 `undefined` 的 bvid 拼进 URL，上游回 -400/404，而命令层看起来只是「这个候选不可播」。

**修完 URL 还撞上第二个坑（同一轮实测）**：插件照抄浏览器的
`accept-encoding: gzip, deflate, br`，而我们这一侧没有解压实现（ureq 没开 gzip/brotli），
上游于是回压缩体 → `read_to_string` 报「stream did not contain valid UTF-8」→
命令仍然 `plugin.runtime_error`。修法：`plugin::transport::outgoing_headers()` 统一丢掉调用方
声明的 `accept-encoding`、按 `identity` 请求；**媒体代理（`media.rs`）复用同一份实现**——
那里更敏感：转发压缩体还会让 `Content-Length` / `Content-Range` 与实际字节数对不上，
Range 拖动会直接坏掉。有单测（`plugin_accept_encoding_is_replaced_by_identity`）。

### 8. 详细说明：UI 布局（bug ②）

用户给的四张截图指向同一件事：**默认窗口（900–916 宽）下表格与播放条都放不下**。

- **表格宽度跟着容器走**（`DataTable.module.css`：`width: max-content` → `width: 100%`）——
  这是真正的病根：`max-content` 让「标题很长」的真实数据（B 站那种
  「【Hi-Res无损音质】｜《海阔天空》- BEYOND…」）把整张表撑到一两千像素，
  专辑 / 时长 / 来源 / 操作全被推到窗口外。锁成 100% 后长文本**在自己的列里**省略号截断，
  其余列照常可见（搜索页实测 7 列全在、无横向滚动条）。
- 列宽下限：原合计 832px（`52+220+120+120+84+96+140`），而最小窗口的内容区只有
  `900-232(侧边栏)-56(页面内边距) ≈ 615` → 下限收到 **598**（`40+124+80+80+56+72+146`）。
- 行内操作放不下时**换行**而不是被裁（`cells.module.css` 的 `.actions` 加 `flex-wrap`）：
  单元格是 `overflow: hidden` + `justify-content: flex-end`，一行塞不下时被裁掉的正是
  **最左边**的「播放 / 收藏」（R41 的教训）。最小窗口下本地曲库那一行 4 个操作会排成 2–3 行，
  行高变高但一个都不少；默认 1280 宽下仍是单行。
- 播放条：`@media (max-width: 900px)` 把整组右侧控件 `display:none`，而那组里有
  **音源 / 音质 / 循环 / 队列 / 功能抽屉**——别处没有入口。改成窄窗只收「音量滑块 + 秒数」
  （音量还有键盘与抽屉两条路），并在 ≤1000px 收窄间距：右侧按钮永不消失。
- 窗口：`tauri.conf.json` 之前只有 `height: 600` 与 `minWidth: 900`，**没有 `width`**——
  Tauri 默认 800 被最小宽度顶到 900，于是「装完就打开的那一刻」正好落在最窄的布局上。
  现在显式 `1280×800`（`minWidth 900` / `minHeight 600`）。

**打包版实测（同一台机器、同一份交付物）**：`1296×809`（新的默认窗口）下本地曲库 7 列全在、
播放条右侧控件齐全（`r53-02-local-scan.png`）；`916×609`（最小窗口）下同样 7 列全在、
播放条仍保留「循环 / 队列 / 抽屉」、4 个行内操作换行后一个不少（`r53-03-window-900.png`）；
浅色主题可读（`r53-04-narrow-light.png`）；搜索页 20 条长标题全部省略号截断、列不再跑出窗口
（`r53-10-generated-plugin-search.png`）。

### 9. 验证

`pnpm verify` 五道全绿：`pnpm typecheck` 通过、`pnpm build` 通过、`pnpm smoke` **312/312**、
`pnpm check:contract` 一致（60 命令 / 8 事件 / 26 错误码）、
`pnpm check:reachability` 通过（服务节点 143 / 动作 69 / 界面 133；有意留白 1 项）、
`cargo test -p gently-core` **218/218**（比上一轮 +6：`.m4s` 入库、扫描 `ignored`、
兼容参数形状 ×2、播放解析用原始条目、`accept-encoding` 归一到 identity；另有 2 项 `#[ignore]`）。
冒烟改动：假宿主下的插件列表断言改为「只有核心那份、不含演示源与占位项」，
并新增三条诚实规则断言（推荐空 bundle、当前音源读核心清单、扫描统计带非音频文件数），
无宿主时先 `await demoSourcesReady` 再读注册表（演示源注册是异步的）。

### 10. 打包版实测证据（R53，全部落在交付物本身上）

交付物：`release/gently-0.1.0-windows-x64.zip`（116.0 MB，内层 exe SHA256
`a0c01dccf425ef8ac5fc217449f81924b98082e595ba0e2ef872cb6ccdf01c3a`），
用 `pnpm ui:capture`（PrintWindow 驱动）在真实窗口里逐条走：

| 验什么 | 命令/操作 | 证据 |
|---|---|---|
| 窗口默认尺寸（bug ②） | 启动即截图 | `1296×809`（配置 1280×800）——不再是 Tauri 默认被顶到 900×600 的最窄布局 |
| 本地扫描认 `.m4s`（bug ①） | 填 `D:\Xun\Music` → 开始扫描 | 界面「扫描 **1** 个文件，新增 **1** … 非音频文件 **1**」；日志 `本地曲库扫描完成 scanned=1 added=1 ignored=1` + `library.local.scan ok=true`；表格出现该曲目（4.2 MB）——`r53-02-local-scan.png` |
| 表格/播放条布局（bug ②） | 916×609 与 1296×809 各截一张；浅色再截一张 | 7 列全在（长标题在列内省略号）、4 个行内操作换行后一个不少、播放条右侧「音源/音质/循环/队列/抽屉」都在——`r53-03-window-900.png` / `r53-04-narrow-light.png` |
| 生产版无 mock（bug ④） | 插件页 + 榜单页 | 插件页「共 **1** 个」且只有核心装的 `bilibili`；榜单页音源筛选只有「全部音源 / B 站音频音源 / bilibili」——没有「内置示例源 / 模拟音源 B/C」——`r53-06-plugin-list.png` |
| 真实 MusicFree 插件不再 404（bug ③） | 榜单页点「入站必刷」 | 日志从 `catalog.topList ok=false …404` 变成 **`ok=true`**，界面显示真实条目（回村三天… / bvid / 11:28）——`r53-05b-compat-precious.png` |
| 真实插件能播（bug ③ 第二半） | 点第一行播放 | `playback.resolve ok=true` → 媒体代理 `GET /m/…`；播放条显示真实封面、`0:08 / 11:27`、源 `bilibili`——`r53-05d-compat-playing.png` |
| 生成的插件端到端 | 插件页「本机路径 → 单文件」导入 `bili-audio.js` → 预览 → 同意 → 安装 | `plugin.preview ok=true`、`插件已安装 id=bili-audio version=1.0.0`、运行时探测 6 项能力；随后它的榜单树/榜单内容/播放都通（`catalog.topList ok=true`、`0:08 / 1:55`）——`r53-07-plugin-preview.png` / `r53-08-plugin-installed.png` / `r53-09b-generated-rank-music.png` |
| 生成的插件能搜 | 标题栏搜「海阔天空」 | 「搜索结果 [海阔天空] 共 20 首」+ 真实条目（`catalog.search ok=true`）；长标题在列内截断、7 列全在——`r53-10-generated-plugin-search.png` |

**已知边界（不冒充已解决）**：**演示数据仍然会被打进产物**（只是永不被使用）。
`catalogService` / `libraryService` / `recommendService` / `TitleBar` 目前是**静态** import
`src/mock/**`（在函数体里由 `coreAvailable()` 门控），因此曲库文案数组仍在主 chunk 里；
`dist/assets/*.m4s`（4.4MB 演示音频）也仍会被 Vite 输出，只被 `demo-sources` 独立 chunk 引用
（该 chunk 在宿主存在时**永不 import**，主 chunk 里搜不到曲库文案、只有一行 chunk 引用表）。
把它们从产物里彻底剔除需要把服务层的 mock 兜底改成动态 `import()`（会改变浏览器预览的
服务层形状）或动构建配置——本轮未做，避免与在途改动冲突；**运行期行为已经是隔离的**：
桌面上没有任何演示音源被注册、没有任何 mock 数据被读到界面。

## 已完成（第五十二轮）

### 1. 解包 → 哈希 → 冷启动 → 交互，四步都落在交付物本身上

| 步骤 | 结果 |
|---|---|
| 解包 | `tar -xf release/gently-0.1.0-windows-x64.zip` → 3 个条目：`gently.exe` + `README.md` + `README-便携版.txt` |
| 内层 exe 哈希 | `37f40a22f91521b3ae20ec5bc1f6d630b3c13cb25c2a04df6fc338e889e0c292`——**与 `release/*.sha256` 逐字符一致** |
| 冷启动（干净数据目录） | 8 条迁移 `0001…0008` 全部执行、`SQLite 就绪 schema_version=8`、凭据 `windows-credential-manager`（`shipped-boot.png`，抽样 245 色 → 确实渲染了，不是白屏） |
| 核心真的在服务前端 | `GENTLY_LOG=debug` 下可见 `library.favorites.list / skin.list / system.status / library.playlists.list / plugin.list` **全部 `ok=true`**（默认 `info` 级别只写 INFO，所以平时看不到 dispatch 行——不是前端没调核心） |
| 点开主题市场 | 10 张内置预设卡片**只有「应用」/「使用中」，没有「删除皮肤」**——上一轮的修复确实在交付版里（`shipped-theme-market.png`） |

### 2. 边界说明（不冒充已验）

- 便携版 zip 里没有 `resources/` 目录：前端产物与 WebView2 引导都已编进 exe（Tauri 默认行为），
  所以「3 个条目」不是漏打包。
- MSI/NSIS、人工听音、macOS/Linux 凭据库仍受环境限制，见 `docs/ROADMAP.md` 的未覆盖清单。

### 3. 验证

本轮**无源码改动**（只加了两张交付物实图），`pnpm verify` 仍五道全绿：
`pnpm smoke` **296/296**、`cargo test -p gently-core` **212/212**、契约一致、可达性通过。

## 已完成（第五十一轮）

### 1. 真 bug：内置预设长出了「删除皮肤」按钮（点了没用、还谎报成功）

现象：主题市场每个卡片（包括 `深海蓝` 这类内置预设）都带「删除皮肤」。
点它 → 二次确认 → 界面提示**「已删除皮肤「深海蓝」」**，而卡片**纹丝不动**。

根因链：
- 视图的守卫是 `{!item.builtin && <删除按钮>}`，而 `src/config/theme/presets.json` 里
  **从来没有写过 `builtin` 字段** → `item.builtin === undefined` → `!undefined === true` → 按钮照常渲染；
- 点下去之后：store 只过滤 `customSkins`（内置 id 不在里面，无事发生）→
  `skin.remove{id:'ocean'}` 到核心必然 `skin.not_found`（核心只认识用户导入的皮肤）→
  这个失败被 `void` 掉 → 视图却无条件 `setStatus(t('skin.removed', …))` ——**成功提示与事实相反**。

修法（一处收口，`src/theme/presets.ts`）：内置皮肤在这里统一补上 `builtin: true`
（`builtinSkins = rawSkins.skins.map(s => ({...s, builtin: true}))`），
而不是要求数据文件每条都写一遍——视图的删除守卫、导出时「要不要问核心」都读同一个标记，
漏写就会退化成「死按钮 + 假提示」。冒烟加一条断言：**内置预设全部带 `builtin` 标记**（296/296）。

### 2. 打包版实测：内置不可删、用户皮肤可删，整条生命周期走通

| 步骤 | 证据 |
|---|---|
| 打开主题市场 | 内置卡片**只剩「应用」**（当前那套显示「使用中」）——死按钮消失（`theme-builtin-no-delete.png`） |
| 粘贴 JSON 导入「探针皮肤」 | `skin.preview ok=true` + `skin.install ok=true`，品牌色立刻变品红，卡片出现在网格末尾且带**「删除皮肤」**（`skin-user-deletable.png` / `skin-user-card.png`） |
| 点它的「删除皮肤」→ 确认 | `skin.remove ok=true`；卡片消失、品牌色回到默认紫、数据库 `skins` 表 **0 行**（`skin-deleted.png`） |

顺带确认了上一轮的导入面板在**浅色/深色**下都正常（本轮截图是深色，上一轮导入那组也是深色，
浅色主题下的面板样式与卡片一致——同一套 token 驱动，没有单独分支）。

### 3. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **296/296**、`cargo test -p gently-core` **212/212**、
契约一致、可达性通过。前端有改动 → 重新打包（exe 见下表说明）。

## 已完成（第五十轮）

### 1. 主题市场补上「粘贴 JSON / 粘贴本机路径」两条导入来源

- 服务层：`skinService.importFromPath(path)`（`{kind:'file'}`），与既有的 `importFromText`（`{kind:'paste'}`）
  同一套流程（先 `skin.preview` 校验，再 `skin.install` 落盘），失败时依旧把核心**被拒的令牌键名**逐条带出来；
  浏览器预览按路径读不了文件，**如实拒绝**而不是假装成功。
- 视图：主题市场的「导入皮肤」按钮改成**展开导入面板**——面板里两个来源标签（粘贴 JSON / 本机路径），
  外加右下角仍然保留「从文件选择…」（原生选择器照旧可用，只是不再是唯一入口）；
  导入成功即应用新皮肤并收起面板，失败按「被拒键名 → 错误码文案 → 原因」逐级显示。
- 文案 zh/en 成对补齐（`skin.sourceJson` / `skin.sourcePath` / `skin.jsonPlaceholder` / `skin.pathHint` …）。
- 样式全部走既有 token（`--panel-padding` / `--panel-radius` / `--search-box-radius` …）：
  第一次提交时用了不存在的 `--card-padding` / `--font-mono`，**被 CSS token 守卫当场拦下**（这就是那条守卫的价值）。

### 2. 打包版实测：粘贴 JSON → 皮肤装上并立即生效（这条路径终于能自动化验收了）

| 步骤 | 证据 |
|---|---|
| 打开主题市场 → 点「导入皮肤」 | 面板展开（`skin-import-panel.png`：来源标签、`皮肤 JSON` 文本域、`导入` 按钮、「从文件选择…」） |
| 在文本域粘贴皮肤 JSON → 点「导入」 | 日志 **`skin.preview ok=true` + `skin.install ok=true`** |
| 结果 | 全站品牌色立刻变成皮肤里的品红 `#ff00ff`（`skin-imported.png`：搜索按钮 / 选中标签 / 卡片「应用」按钮都变了色），面板自动收起；数据库 `skins` 表出现 `probe-skin / 探针皮肤` |

上一轮那条「选择器能弹出来、按钮驱动不了」的**自动化盲区就此消失**：现在有两条不依赖原生选择器的入口
（粘贴 JSON、粘贴路径），三条来源都由核心做同一套校验与落盘。

### 3. 验证

- 冒烟新增两条假宿主断言：粘贴 JSON 走 `{kind:'paste'}`、按路径走 `{kind:'file'}`（路径原样带过去），
  且各自都真的调了 `skin.preview` + `skin.install` → **295/295**；
- `pnpm verify` 五道关卡全绿；`cargo test -p gently-core` **212/212**；
- 因前端有改动，重新打包便携版，exe 与 zip 均更新（见下表）。

## 已完成（第四十九轮）

### 1. 工具：把「对话框句柄」记下来，坐标系不再漂

新增三步（写进脚本用法注释）：

| 步骤 | 作用 |
|---|---|
| `dialog` | 把**当前前台窗口**记成「对话框」并打印尺寸（此刻应用窗口正被它禁用，不会认错） |
| `shotdlg:路径` | 相对那扇对话框截图（不随前台漂移） |
| `clickdlg:x,y` | 相对那扇对话框点击 |

配上已有的 `nofocus`（这几步别抢前台），判定「有没有对话框」也有了硬判据：
`IsWindowEnabled(应用主窗口)` 从 True 变 **False** 就是模态窗打开了。

### 2. 结果：**输入进得去，按钮点不动**（如实记录）

复现一遍（打包版 + 干净数据目录）：

| 步骤 | 结果 |
|---|---|
| 点主题市场「导入皮肤」 | 应用主窗口 `enabled=False` → 模态文件选择器打开；`shotdlg` 拍到标准 Win32「打开」对话框（960×540） |
| `clickdlg` 到「文件名(N):」+ 粘贴完整路径 | **成功**：`skin-dialog-filled.png` 里字段中就是 `C:\…\probe-skin.json` |
| `clickdlg` 到「打开(O)」/ 换 `key:0x0D` 回车 | **都不生效**：对话框一直开着（复查 `IsWindowEnabled` 仍是 False），核心侧始终没有 `skin.preview` |

也就是说：**合成输入能进对话框的文本框**（那个框默认就有焦点，Ctrl+V 直接落进去），
但**点不动它自己的按钮、回车也不触发默认按钮**。离线环境里我没有别的办法把这一步走完。

**这意味着什么**：皮肤导入的**产品行为**没问题（选择器弹得出来、人手动选一个文件即可完成），
核心侧的导入链路另有覆盖——`core/tests/skin.rs` 8 项（`skin.preview`/`skin.install` 的校验与落盘）、
冒烟里皮肤门面的服务层断言（非法文本算失败、被拒令牌逐条列出）；
**只有「文件选择器 → 读文件文本」这一小段浏览器 API 胶水**没有在真机上自动验过，
本次如实记为**未覆盖**，不拿「选择器能弹出来」当作端到端通过。

### 3. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **293/293**、`cargo test -p gently-core` **212/212**、
契约一致、可达性通过。本轮**无产品源码改动**（只改驱动脚本与文档），
exe 与上一轮同一份：`2bb411c8…22ce`。

## 已完成（第四十八轮）

### 1. 结论：原生选择器**是有的**，而且点了真的会弹出来

证据链（都在打包版上）：

| 观察 | 手段 | 结果 |
|---|---|---|
| 「导入皮肤」按钮点得动 | 同一行工具栏的「导出当前皮肤」点了会落盘（`Downloads` 里多一份 `ocean.gently-skin (N).json`） | 说明这一排的坐标与点击都有效 |
| 点完之后**弹出了模态对话框** | `IsWindowEnabled(主窗口)` | 点击前 `enabled=True`，点击后 **`enabled=False`**（主人窗口被模态对话框禁用——这是「有模态窗」的铁证） |
| 那扇窗就是系统的「打开」文件选择器 | 新加的 `shotfg:` 步骤（截**当前前台窗口**，而不是应用窗口） | 截图是标准 Win32 打开对话框：目录树 + 文件列表 + 「文件名(N):」+「打开(O)」/「取消」（`skin-file-dialog.png`） |

**于是 AGENTS/README 那句要澄清**：「没有原生文件选择器」只对 **Tauri 的 dialog 插件**成立
（它不在离线依赖缓存里），**WebView 自己的文件选择器是可用的**——皮肤导入因此**不是**一个死按钮。
（插件导入仍然走「粘贴路径」：那是产品选择，不是能力缺失。）

### 2. 如实记下的边界：模拟输入驱动不了系统对话框

继续尝试把导入走完（在文件名框里粘贴完整路径 → 回车 / 点「打开」）时，路径**确实**进了文件名框
（`shotfg` 拍到 `C:\…\probe-skin.json`），但点「打开(O)」/ 回车都没能激活那个按钮，核心侧
始终没有 `skin.preview`，对话框一直开着。原因大概率是**前台窗口在几步之间被换走了**：
`GetForegroundWindow()` 在两次探测里分别返回应用窗口与对话框，而 `clickfg` 是按当前前台窗口算坐标的——
前台一旦是应用窗口，`(780,501)` 就落在应用自己的页面上（点了个空）。
这条**没有**在离线环境里跑通端到端，如实记下来；顺带把为此加的三个驱动能力写进脚本注释：
`nofocus`（这几步别抢前台）、`shotfg`（截前台窗口，专看原生对话框）、`clickfg`（相对前台窗口点击）。

### 3. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **293/293**、`cargo test -p gently-core` **212/212**、
契约一致、可达性通过。本轮**无产品源码改动**（只改驱动脚本与文档），
exe 与上一轮同一份：`2bb411c8…22ce`。

## 已完成（第四十七轮）

### 1. 交付物里的说明写错了一件事实（已修）

`README-便携版.txt`（用户解压后第一眼看到的那份）在「已知限制」里写着：

> 第三方凭据当前存在内存里，重启后需要重新填写（真正的系统钥匙串尚未接入）。

这句**早就过时了**：Windows 的凭据管理器在更早的里程碑就接上了，
设置页诊断卡片实测显示 `windows-credential-manager`「已接入系统凭据库（重启后仍在）」。
这类错误比代码 bug 更伤：用户会因为一句说明而不敢用插件凭据功能。

修法：改 `scripts/package-portable.mjs` 里生成说明的那段模板——写清「Windows 存进系统凭据管理器
（目标名 `gently:<插件 id>:<键>`，重启后仍在）；macOS / Linux 尚未接入，那两个平台退回进程内存储，
设置页诊断卡片会如实显示」，重新打包后 zip 内那份说明已是正确版本。

### 2. 交付物验收：解压 zip → 跑解压出来的那份 exe

| 检查 | 结果 |
|---|---|
| 解压 | `release/gently-0.1.0-windows-x64.zip` → `%TEMP%\gently-ship-check\`，只有 `gently.exe` / `README.md` / `README-便携版.txt` 三项 |
| 字节一致 | 解压出来的 exe 与打包目录里的 exe **SHA256 完全相同**（`2bb411c8…22ce`） |
| 随包说明 | zip 内 README 是当前版本（293 项 / 内嵌封面 / MSI 需联网）；便携说明的凭据那句已改正 |
| 运行 | 从解压目录启动：`SQLite 就绪 schema_version=8` → 迁移 8 条 → 数据库落在 `%APPDATA%\com.xun.gently\gently.db`；`-AssertRendered` 通过 |
| 界面 | 排行榜正常；诊断卡片与从仓库构建的那份**逐像素一致**（核心 v0.1.0 / windows-x86_64 / 数据库已就绪 / `windows-credential-manager` / 统计 0·0·0·0 / 数据与日志目录真实路径）——`ship-check-ranking.png`、`ship-check-diagnostics.png` |

### 3. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **293/293**、`cargo test -p gently-core` **212/212**、
契约一致、可达性通过。本轮**无源码改动**（改了打包脚本里的说明模板 + 文档），
exe 与上一轮同一份：`2bb411c8…22ce`。

## 已完成（第四十六轮）

### 1. 安装包：确认**确实**需要联网（不是没试）

查本机：`candle.exe / light.exe / wix.exe / makensis.exe` 都不在 PATH，
`%LOCALAPPDATA%\tauri`（Tauri 缓存的 WiX/NSIS）、`Program Files\WiX Toolset v3.11`、`Program Files\NSIS` 全部不存在。
`pnpm tauri build` 打 MSI 需要先下载 WiX，因此这条**环境受限**成立（有查证过程，不是想当然）。
离线可交付的仍是便携版 zip（下一步顺手刷新了它）。

### 2. 交付物里的文档是旧的 → 重新打包

审计发现 `release/gently-0.1.0-windows-x64.zip` 里那份 `README.md` 还停在 R43 之前的版本
（写着冒烟 287 项、没有内嵌封面那一段）。`pnpm package:portable` 重新打包后：
zip 内 README 已是当前版本（293 项 / 内嵌封面 / MSI 需联网三处都在），**exe 字节未变**
（`2bb411c8…22ce`，重新打包只刷新了随包文档）。

### 3. 浏览器预览：真实浏览器里跑通了

做法：`pnpm build` → `pnpm preview`（vite preview，`http://localhost:4173`）→ 用 Edge 的
「应用窗口」模式打开（`--app=` + 独立 profile），再把 Edge 当成目标窗口驱动截屏。

| 观察 | 结果 |
|---|---|
| 首屏 | 排行榜页正常渲染：7 条 mock 曲目、侧边栏「我的收藏 4 / 两个歌单」、深色主题（`browser-preview.png`） |
| 其它页面 | 下载管理列出 mock 任务（进度条在走、来源徽标 `mock`）、设置页各开关都在 |
| 诊断卡片 | 运行环境显示**「浏览器模式」**并说明「浏览器预览使用 mock 数据；桌面端由本机核心提供曲库、播放与本地库」；核心版本/平台/数据库/凭据/统计/目录这些行**不出现**（`browser-preview-settings.png`）——**没有拿假信息冒充核心**，正是契约要求的诚实行为 |

为此把驱动脚本从「只会驱动 gently」升级成**通用窗口驱动**：
新增 `-ProcessName`（目标进程名）与 `-AppUrl`（自己拼 `--app/--window-size/独立 profile`，
免得命令行里以 `--` 开头的值被 PowerShell 当成参数名）；
`Get-GentlyWindow` 改成**遍历全部同名进程**取面积最大的可见窗口——Edge 是多进程的（8 个 msedge 里
只有 1 个持有那扇窗），以前只取「最新启动的那个」，直接找不到窗口。

### 4. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **293/293**、`cargo test -p gently-core` **212/212**、
契约一致、可达性通过。本轮**无源码改动**（改了驱动脚本与文档），exe 与上一轮同一份：`2bb411c8…22ce`。

**坐标笔记**：Edge 应用窗口比 Tauri 窗口在顶部多约 23px（自带一条细标题栏），
所以同一排工具栏图标在浏览器里是 y≈60（Tauri 里是 y≈37）；x 坐标两者一致。

## 已完成（第四十五轮）

### 审计出并修掉的陈旧表述

| 位置 | 原文（陈旧） | 现在 |
|---|---|---|
| `AGENTS.md` §1 | 「当前阶段：UI / 前端交付，数据全部为 mock」 | 「桌面端已完整」：核心实现契约全部 60 条命令（沙箱/本机库/封面/回环代理/推荐/皮肤/下载/订阅）；mock 只是**浏览器预览**的兜底 |
| `AGENTS.md` §5 / `README.md` 命令表 | 冒烟 **287** 项、核心单测 **207** 项 | **293** / **212**（与 `pnpm smoke`、`cargo test` 实测一致） |
| `docs/ARCHITECTURE.md` §1 依赖图 | `mock/ ← 当前阶段的假数据（后续被插件替换）` | 只在**无 Tauri 宿主**时兜底；桌面端一律以核心为准 |
| `docs/ARCHITECTURE.md` §11 核心框图 | `Rust 本机核心（规划中）`，且缺本地曲库/封面缓存/推荐 | 标注**已实现**（60 命令 / 212 项测试），补齐封面缓存、`/cover/<name>`、推荐（零出网）等分支 |
| `docs/ROADMAP.md` 里程碑标题 | M0「仅视觉确认待人工」、M1/M1c/M2「进行中」、M3/M5 无状态 | M0–M5 全部**已完成**（各自括号里点名证据；只剩联网打 MSI/NSIS 与人工听感两件环境受限项） |
| `docs/STATE.md` 验证表 | 冒烟 **291/291**、桌面端分支 41 项 | **293/293**、43 项（含本轮新增的两条皮肤导出断言） |
| `docs/STATE.md` 刻意留白 | 只列 `library.history.push` | 补齐 action `actions.player.stop`（与可达性守卫的 `DELIBERATE_ACTIONS` 对齐） |
| 契约 §11 性能预算 | 只有四条预算数字，没有实测 | 附上 R39 的实测口径（1000 个 WAV：首扫 124 ms / 重扫 21 ms / 检索 P95 1.11 ms；外推 1 万文件 ≈1.2 s，注明是下界与测量入口） |

### 顺带确认干净的两项

- **代码里没有 `TODO/FIXME` 占位**（全仓扫过；唯一命中是歌词注释里的 `[mm:ss.xxx]` 格式说明，误报）；
- **契约三处一致**：`pnpm check:contract` 60 条命令全部有前端封装、事件名四处比对通过。

### 验证

`pnpm verify` 五道关卡全绿（smoke **293/293**、核心 **212/212**、契约一致、可达性通过）。
本轮**只改文档**，交付物与上一轮同一份（exe `2bb411c8…22ce`）。

## 已完成（第四十四轮）

### 1. 设置页：诊断卡片的值是真的，两个「打开目录」真的打开了

打包版实测（`settings-diagnostics-page.png`）——卡片里的每一项都与真实环境对得上：

| 项 | 显示 |
|---|---|
| 运行环境 | 已连接核心（+「刷新」重新探一次） |
| 核心版本 / 运行平台 | `v0.1.0` / `windows-x86_64` |
| 数据库 | 已就绪 |
| 凭据存储 | `windows-credential-manager`（已接入系统凭据库，重启后仍在） |
| 条目统计 | 插件 0 · 收藏 0 · 曲目 0 · 下载 0（与刚清空的数据目录一致） |
| 数据目录 / 日志目录 | 都给出真实路径，旁边的按钮点了就是 `system.reveal ok=true`（两次，分别打开数据目录与日志目录） |

### 2. 「危险操作前二次确认」关掉之后，危险操作确实不再弹窗

做法：设置页把该开关切到**禁用**（界面提示「关闭后，删除 / 清空 / 卸载类操作会立即执行」），
回本地曲库点某一行的「移除」——**没有弹确认框**，`library.local.remove ok=true` 直接落库，
`local_tracks` 3 → 2（`settings-confirm-off-removed.png`）。
这条链把「设置项 → `useConfirm` → 危险操作」整条走通了，而不是只看开关的字面状态。

### 3. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **293/293**、`cargo test -p gently-core` **212/212**、
契约一致、可达性通过。本轮**无源码改动**，交付物与上一轮同一份（exe `2bb411c8…22ce`）。

**坐标笔记**：设置页右侧那排「确定 / 禁用 / 浅色 / 深色」是**纯文本按钮，命中区就是字形本身**——
按行中心估会点到两个词之间（本轮 1401 落空，量出字形簇在 1418 才点中）。
1500×900 下：齿轮 1304、诊断卡片「打开数据目录」= (1388, 673)、「打开日志目录」= (1388, 722)。

## 已完成（第四十三轮）

### 干净环境完整链路（一次会话，数据目录先清空）

起点：`%APPDATA%\com.xun.gently` 里没有数据库、没有插件（只剩空的目录骨架）。全程 `GENTLY_LOG=debug`。

| # | 动作 | 证据 |
|---|---|---|
| 1 | 启动（自动建库 + 迁移 8 条） | 日志 `SQLite 就绪 schema_version=8` |
| 2 | 扫描本地目录 | `library.local.scan ok=true`，库里 `local_tracks = 3`（mp3 / 无封面 mp3 / flac） |
| 3 | 播放本地曲目 | `playback.resolve ok=true` + 回环代理 `GET /m/…`（`status=206 total=12945`） |
| 4 | 收藏本地曲目 | `library.favorites.set ok=true` → `favorites` 里出现 `local:…/embed-cover.mp3` |
| 5 | 导入插件（本机路径 → 单文件 → 检查 → 勾选同意 → 安装） | `plugin.preview ok=true` → `plugin.import ok=true` + `plugin.reload ok=true`；日志 `插件已加载 plugin=probe-source capabilities=[Search, GetMediaSource, GetTrackInfo, GetLyric]` |
| 6 | 流式搜索 | `catalog.search ok=true`；结果 2 条，首条带插件的 data-URI 封面色块 |
| 7 | 播放插件曲目 | `catalog.lyrics ok=true` + `catalog.track ok=true` + `playback.resolve ok=true`；代理请求上游 `https://example.com/probe-1.mp3` 因离线失败（预期），进度改走模拟时钟（0:33 / 3:30） |
| 8 | 收藏插件曲目 | `library.favorites.set ok=true` → `favorites` 里出现 `probe-source:1` |
| 9 | 收尾核对 | 库里：`local_tracks=3`、`favorites=2`（本地 + 插件各一）、`play_history=1`、`plugin_state=1`（enabled） |

截图：`accept-1-scan.png`（扫描结果）、`accept-3-plugin-installed.png`（插件已安装）、
`accept-4-plugin-search.png`（插件搜索结果 + 封面）、`accept-5-plugin-playing.png`（插件曲目在播）、
`accept-6-plugin-favorited.png`（播放条显示插件曲目与来源 `probe-source`）。

**结论**：ROADMAP 的退出标准**代码侧全部满足**；只剩「联网打 MSI/NSIS」与「人工听一次扬声器」
两件环境受限的事（ROADMAP §2 与 README 都写着）。

**记两条坐标坑**：插件预览面板里的同意复选框会**随内容（覆盖提示那一行）整体下移**，
且**未勾选前「安装」是禁用的**（点了没反应不是 bug）；勾选后要重新量一次按钮位置。

### 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **293/293**、`cargo test -p gently-core` **212/212**、
契约一致、可达性通过。本轮**无源码改动**，交付物与上一轮同一份（exe `2bb411c8…22ce`）。

## 已完成（第四十二轮）

### 1. 打包版插件链路重新验收（当前构建）

自写夹具插件（`%TEMP%\gently-plugin-probe\probe.js`：`@hosts example.com`、封面用 data URI 品红 PNG）：

| 环节 | 结果 |
|---|---|
| 导入（本机路径 → 单文件） | `plugin.preview ok=true` → 面板列出**权限**（网络访问：仅限插件自己声明的域名）与「已有同 id 插件将被覆盖」的橙色提示；勾选同意后 `plugin.import ok=true` + `plugin.reload ok=true`，插件列表出现「探针音源 v1.0.1 已启用」 |
| 流式搜索 | `catalog.search ok=true`；结果页 2 条：`探针一号 探针`（**带插件的品红封面**）、`探针二号`（无封面 → 渐变），时长 `3:30 / 3:00`（由 `durationSec` 归一化），来源徽标「1 个音源」 |
| 播放 | `playback.resolve ok=true` + `catalog.track ok=true`（详情）+ `catalog.lyrics ok=true`（歌词）；回环代理 `GET /m/…`，随后 `上游媒体请求失败 err=https://example.com/probe-1.mp3`（离线环境预期） |

结论：R37–R43 那些改动（封面缓存/路径归一化/表列宽/下载/皮肤）没有碰坏插件链路；
**插件的 `artwork` 在新加的封面列里照常渲染**。

### 2. 契约补一条：`getMediaSource(track, quality)` 的第一个参数是**曲目对象**

夹具第一版写成 `getMediaSource(id, quality)` 再拼 `id`，于是 URL 变成
`https://example.com/probe-[object Object].mp3`——命令全 ok、界面上也「在播」，只有翻到上游请求那行才看得出来。
契约里已写明：第一个参数是**曲目快照**（`track.id` 才是源内原始 id），
而 `getTrackInfo/getLyric` 这类才是**字符串 id**——省得插件作者再踩一遍。

### 3. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **293/293**、`cargo test -p gently-core` **212/212**、
契约一致、可达性通过（139/65/130，留白 2 项）。本轮**只改了契约文档**（无源码改动），
因此交付物与上一轮同一份：exe `2bb411c8…22ce`。

**坐标笔记**：1500×900 下插件页「本机路径」子标签 y=312、路径输入 y=369、「检查」= (302,554)；
预览面板里同意复选框会**随内容（覆盖提示那行）整体下移**，需要在截图里量（本轮是 (312,743)），
「安装」在未勾选同意前是**禁用**的（点了没反应不是 bug）。

## 已完成（第四十一轮）

### 1. 循环模式：按键有效，`all` 真的会绕回队首

- **界面**：连点循环按钮，按钮出现品牌色按下态（`aria-pressed`），再点回 off——把三次点击后的按钮
  放大并排（`repeat-phases.png`）看得一清二楚；off/all/one 三态的图标差异只有 `one` 多一个「1」。
- **行为**：先点成 `all` 再放 3 秒的 WAV，日志出现**连续 5 个循环**
  （每 ~3.1 秒一组 `playback.report` + `recommend.feedback complete` + 紧接着新的 `playback.resolve`）——
  「循环播放全部」确实绕回队首重播。
- 中途踩到的坑：截图本身很慢（重绘 + 采样），先截图再点按钮会把「点按」推到曲目播完之后，
  于是日志看起来像「循环没生效」。**顺序要摆对**：先设模式，再播放。

### 2. 主题市场：应用预设生效，导出皮肤能拿到文件

- 点「深海蓝」的**应用** → `skin.setActive ok=true`，全站配色立刻变（`theme-preset-applied.png`）；
- 点**导出当前皮肤** → 下载真的落了盘：`%USERPROFILE%\Downloads\ocean.gently-skin.json`（819 字节），
  内容是合法的皮肤 JSON（id/name/description/swatches/palette 齐全）。
  WebView2 的下载通道可用，导出不是「点了没反应」。

### 3. 真问题：导出**内置**预设会去问核心，换来一条误导性告警

日志里躺着：`skin.export ok=false code="common.not_found" 皮肤未安装：ocean`。
根因：导出统一先问核心，而**核心只认识用户导入的皮肤**（`skin.list` 里没有内置预设）——
拿 `ocean` 这类内置 id 去问必然 not_found，然后前端再退回本地序列化。结果是对的，但白跑一趟、
还在日志里留下一条会让人以为「皮肤装丢了」的告警。这与 R27「演示源不问核心」、R37「本地曲目不问歌词」同一类收口：

修法（`skin.service.ts`）：`builtin !== false` 的皮肤**直接前端序列化**，只有用户皮肤才取核心原文。
冒烟新增两条断言（内置不问核心仍拿到 JSON / 用户皮肤取核心原文）；
打包版复测：导出内置预设时日志里只剩 `skin.list`，**告警消失**，文件照常落盘。

### 4. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **293/293**（+2 皮肤导出断言）、
`cargo test -p gently-core` **212/212**、契约一致、可达性通过（139/65/130，留白 2 项）。

**坐标笔记**：1500×900 下标题栏图标是 灯泡 1236 / 调色板 1270 / 齿轮 1304 / 画中画 1358（不是 916 宽时的 668/695/722）；
主题市场工具栏：导入皮肤 ≈1308、导出当前皮肤 ≈1406，卡片首行「应用」在 y≈452。

## 已完成（第四十轮）

### 1. 工具：`drag:x1,y1,x2,y2`（分步拖拽）

SeekBar 与音量滑杆**只能拖**，而脚本以前只有 click/move/wheel。新增 `drag`：按下 → 分 12 步移动到终点
（每步都发 `pointermove`，一步跳到终点有些控件收不到移动事件、松手会回弹）→ 抬起。
拖动前同样会重新抢前台。

### 2. 打包版实测：进度条 / 音量 / 曲目详情

| 控件 | 做法与结果 |
|---|---|
| SeekBar（播放条顶边） | 放 3 秒的 WAV，从 x=300 拖到 x=1000 → 顶边品牌色进度条**正好画到 x=999**（逐像素量），时间显示 `0:02 / 0:03`（`seekbar-dragged.png`） |
| 音量滑杆 | 把滑块从 x≈1449 拖到 1395 → 填充条从 x=1456 缩到 1402（逐像素量，`volume-dragged.png`） |
| 曲目详情页 | 点播放条封面进入 `/now-playing`：封面 + 标题 + `暂无歌词`（WAV 没有歌词）+ 返回按钮，布局正常（`now-playing.png`） |

### 3. 真 bug：下载失败的原因会被「打开下载管理」抹掉

在收藏页点「下载」（本地曲目），核心给的是**明确拒绝**：
`download.create ok=false code="common.invalid_argument" 本地曲目不需要下载（文件已经在本机）`。
store 也按设计留下了一条带错误码的任务——**但打开「下载管理」时它消失了**，页面显示「暂无下载任务」。

日志把因果写得很清楚：`download.create`（拒绝）之后紧跟一条 `download.list`。
根因：`download.load()` 用核心列表**整个覆盖** `tasks`，而 `dl:<track.id>` 这类「本机持有」的任务
（核心拒绝后留下的失败项、浏览器里的模拟项）核心根本不知道它们存在，于是被一起冲掉。

修法：`load()` 合并——保留本机持有的任务，只把核心那份并进来（`download.slice.ts`）。
冒烟新增断言「刷新下载列表不会丢掉本机失败任务」；**负向验证**：改回覆盖式 → 断言立刻红。

### 4. 真 bug（产品口径）：本地文件不该有「下载」按钮

核心自己说得很清楚——本地曲目**已经在本机**，不需要下载。界面却照样给了一个「下载」，
点了必然失败（上面那条 `common.invalid_argument`）。这比「没有按钮」更糟：用户会以为能下、还失败得莫名其妙。

修法：抽出纯函数 `canDownload(track)`（`source !== 'local'`），`useTrackActions` 用它决定是否给这个操作；
冒烟加断言（本地 false / 插件源 true），打包版实测：收藏页那一行的操作只剩 **播放 · 取消收藏**（`favorites-no-download.png`）。

### 5. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **291/291**（+2 下载断言）、`cargo test -p gently-core` **212/212**、
契约一致、可达性通过（139/65/130，留白 2 项）。

**坐标笔记**：本地页的表格行位置取决于扫描面板有没有「上次扫描」统计那一行（有则整体下移 ~36px）；
播放条右侧图标竖直中心在 y≈850；收藏页那一行在 1500×900 下是 y=228。

## 已完成（第三十九轮）

### 1. 工具：截图会抓到**上一帧**（现在抓之前先强制重绘）

现象：日志里 `library.favorites.set ok=true`、库里 `favorites=1`，可截图上的 ♡ 还是空的、
侧边栏也没有新歌单——按图判断会得出「功能没生效」的错误结论。根因是 WebView2 的合成结果
不刷新时 `PrintWindow` 会返回上一帧（R36 见过「两张图一模一样」，这次换了个更容易骗人的形态）。
修法：抓图前 `RedrawWindow(RDW_INVALIDATE|RDW_UPDATENOW|RDW_ALLCHILDREN)` + `InvalidateRect` + `UpdateWindow`
再等 350ms；修完后同一场景的截图与日志/数据库一致（♡ 是实心红的）。

**方法论（写给下一轮）**：判断「功能有没有生效」以**日志 + 数据库**为准，截图只用来判断「长什么样」；
两者不一致时先怀疑截图。

### 2. 真 bug：行内操作列把最前面的按钮裁掉了（「播放 / 收藏」点不到）

在 1500×900（不出现横向滚动）下量本地曲库的「操作」列（`actions-column-before.png`）：
只剩 **在文件夹中显示 / 移除**，`播放` 与 `收藏` 不见了。根因：操作列固定 140px，
而单元格是 `display:flex; justify-content:flex-end` + `overflow:hidden`——内容比列宽时
溢出被裁在**左侧**，正好是最前面那两个按钮（本地 4 个操作：播放/收藏/在文件夹中显示/移除）。
修法：列宽改成 `minmax(140px, max-content)`（2 个操作时保持紧凑，4 个操作时自动变宽），
修完后同一位置四个按钮齐全（`actions-column-after-zoom.png`），并且「收藏」会随状态显示成「取消收藏」。

### 3. 打包版实测（歌单与队列）

| 路径 | 结果 |
|---|---|
| 歌单重命名 | 输入框 → 新名字 → 回车：界面标题与侧边栏同步改名；库里 `playlists.name` 与 `updated_at` 都变了（`playlist-renamed.png`） |
| 歌单删除 | 危险操作走 `useConfirm()`；确定后 `library.playlists.delete ok=true`，`playlists` 与 `playlist_tracks` 双双归零（外键级联），侧边栏回到「还没有歌单」，当前路由显示「歌单不存在」（`playlist-deleted.png`） |
| 行内移除本地曲目 | 点「移除」→ 确认 → `library.local.remove ok=true`，`local_tracks` 3 → 2，列表立刻少一行（`local-removed.png`） |
| 播放队列抽屉 | 打开后分段显示「正在播放 / 接下来播放 / 已播放」；点「已播放」那一行切歌成功（日志两次 `playback.resolve`，正在播放与接下来的分组随之互换）；「清空队列」后只剩当前曲目、按钮变灰（`queue-panel.png` / `queue-switched.png` / `queue-cleared.png`） |

**踩到的两个坐标坑**（写进脚本注释）：播放条图标的竖直中心在 y≈850（845 落在字形上沿，点不动）；
队列抽屉有入场动画，点里面的行要等 ~3 秒（2 秒时点击会落空）。

### 4. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **289/289**、`cargo test -p gently-core` **212/212**、
契约一致、可达性通过（139/65/130，留白 2 项）。

## 已完成（第三十八轮）

### 1. 工具：长流程里合成点击会丢（每次输入前重新抢前台）

症状很迷惑：脚本每一步都打印「click x,y」，但日志里一条命令都没有，表现为「点了没反应」。
根因不在应用：`SetForegroundWindow` 只在**开头**调了一次，十几秒的流程里别的窗口会把前台抢走，
`SetCursorPos` + `mouse_event` 合成出来的点击于是落到**别的窗口**上。修法：`click/paste/key/enter/move/wheel`
每步之前都 `Focus-App`（抢回前台；抢不回来直接警告），并把这条教训写进脚本注释。

### 2. 真 bug：抽屉里「新建歌单并加入当前曲目」静默失败

打包版实测（`playlist-add-before-fix.png`）：抽屉提示**「已加入「夹具歌手 的歌单」」**、侧边栏歌单计数却是 **0**、
库里 `playlist_tracks` 也是 **0**，日志里只有一条 `library.playlists.save ok=false 歌单不存在：pl:mv3j4qgw1`。

根因：桌面端歌单 id 由**核心**分配，而界面先建了一个本地占位 id（`pl:…`）用来即时反馈；
「先建歌单、再补一次写入把曲目塞进去」的第二次写入拿的是占位 id——核心不认识它，**静默**失败
（`void` 吞掉了），随后核心返回的空歌单又把界面那份覆盖掉。于是提示与数据完全相反。

修法（`collection.slice.ts` / `ActionsPanel.tsx`）：
- `createPlaylist(name, tracks?)` 支持**初值曲目**，建的时候就把它们交给核心（核心分配 id 时一并落库）；
- 占位 id 在核心确认前**不写核心**（`pendingCreateIds`），避免那条必然失败的写入；
- 核心确认后若界面上的曲目比核心那份多（确认前用户又加了歌），才补写一次——正常路径只写一次；
- 侧边栏「+ 新建」不受影响（没有初值曲目）。

冒烟新增两条假宿主断言（`library.playlists.save` 的假实现与真实核心同形：无 id = 新建、占位 id = `not_found`）：
「新建歌单只写一次，且把初值曲目一起交给核心」「核心确认后占位 id 换成核心 id，曲目没丢」。
**负向验证**：把初值曲目从创建写入里去掉 → 断言立刻红。

### 3. 真 bug：快照里的封面地址会过期（收藏/历史/歌单显示不出封面）

修好上一条后看到新问题：收藏页那一行**没有封面**，而本地页同一首歌有（`favorites-page` 修复前后对比）。
根因：收藏/历史/歌单存的是**曲目快照**，里面那份 `artwork` 是当时那个回环端口
（`http://127.0.0.1:<port>/cover/…`）——**端口每次启动都会变**，旧地址下发给 WebView 只能得到一张加载失败的图。

修法：本地封面的名字由**路径**派生，所以核心在下发快照时按路径**重新签发**当前有效的地址
（`local_library::refresh_local_artwork`，收藏/历史/歌单/候选曲目共用 `normalized()` 这一处）；
封面确实没了就顺手删掉字段，让界面退回渐变而不是显示破图。
核心测试 `stored_snapshots_get_a_fresh_local_cover_url` 断言「旧端口地址不会被原样下发、重新签发的地址真能取到字节、
与本地列表给的是同一个地址、候选曲目同样刷新」；**负向验证**：去掉刷新 → 断言立刻红。

### 4. 打包版实测（三条路都走通）

| 路径 | 证据 |
|---|---|
| 播放 → 点播放条 ♡ | 日志 `library.favorites.set ok=true`；库里 `favorites` 1 行；收藏页显示该曲目**带品红封面**（深色 `favorites-page.png` / 浅色 `favorites-light.png`） |
| 播放 → 功能抽屉「+ 新建歌单」 | 日志只有**一次** `library.playlists.save ok=true`（修复前是 `ok=false not_found`）；库里 `playlists` 1 行 + `playlist_tracks` 1 行（position 0）；歌单页显示该曲目带封面（`playlist-page.png`） |
| 播放 → 暂停 → 最近播放 | 暂停触发 `playback.report`，库里 `play_history` 1 行；最近播放页「共 1 首 / 刚刚」，带封面（`recent-page.png`） |
| 侧边栏分组折叠 | `sidebar-group-collapsed.png` / `sidebar-group-expanded.png`（R37 的重构后仍未坏） |

### 5. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **289/289**（+2 歌单创建断言）、
`cargo test -p gently-core` **212/212**（+1 快照封面签发）、契约一致、可达性通过（139/65/130，留白 2 项）。

## 已完成（第三十七轮）

### 1. 核心：内嵌封面 → 缓存 → 回环地址（前端零改动）

- 新增 `core/src/covers.rs`：封面文件名 = **源路径 SHA-256 前 16 字节 + 图片扩展名**
  （白名单 `png/jpg/jpeg/webp/gif/bmp`，单张 ≤ 2 MiB，先写 `.part` 再改名）。
  用路径派生名字的好处：`library.local.list` **不必回查数据库**就能判断封面在不在；
- 扫描时把 symphonia 读到的 `Visual` 落盘；`local.list` 命中就给一项
  `artwork = http://127.0.0.1:<port>/cover/<name>`；曲目被移出曲库时顺手删掉封面文件（不留孤儿）；
- 媒体代理新增 `/cover/<name>` 路由（与音频同一条仅回环服务）：**只**服务封面缓存目录里
  名字合规的文件，目录穿越 / 任意文件名 / 非白名单扩展名一律 404——它不是通用文件读取接口。

### 2. 顺手照出三个真 bug（都不是「加功能」能掩盖的）

| 现象 | 根因 | 修法 |
|---|---|---|
| 封面写进了缓存，列表却永远给不出地址 | 写的时候是**文件系统路径**（Windows 带 `\`），回查时用的是库里统一的 `/` 路径 → **两侧算不出同一个哈希** | `file_name()` 走与曲目 id 同一份路径归一化；并加单测（负向验证：去掉归一化，测试立刻红） |
| 本地 mp3 的标题/歌手/专辑/封面**全都读不到** | symphonia 0.5.5 的 mp3 demuxer **不解析 ID3v2**：这些只出现在探测阶段的**链式元数据**（`ProbeResult.metadata`），容器自己的 `format.metadata()` 是空的 | `read_tags()` 改为**两边都读**（容器 → 链式，先到先得），并用**手写 ID3v2.4 夹具**（TIT2/TPE1/TALB + APIC，中文 UTF-8）端到端钉住 |
| 同一个文件在曲库里出现**两行** | 粘进扫描面板的 `C:\\…\\dir`（重复分隔符）Windows 照样认，但按字符串派生的 id 与库里的 `path` 都带着 `//` → 变成第二个「文件」；清理时又因为范围比较对不上而永远清不掉 | 路径归一化收成**一份实现**（`paths::normalize_source_path`：`\`→`/` + 折叠重复分隔符 + 去尾），曲目 id / 库内 `path` / 封面文件名 / 扫描范围比较四处共用；旧库里已有的重复行会在下一次扫描时被清掉 |

第三个 bug 还有**第二半**：清理重复行时会顺手删封面文件——而活着的那一行用的就是同一份
（归一化后同名），列表上的封面于是莫名退回渐变（实测撞到）。清理现在先看「是否还有活着的同源曲目」，
有就不删；正反两条路径都有测试（`stale_duplicate_row_does_not_delete_the_live_cover`，
负向验证：去掉守卫，测试立刻红）。

### 3. 界面：列表标题列带封面缩略图

- 新增主题 token `components.table`（`coverSize/coverRadius/coverGap`），
  `titleColumn` 渲染「缩略图 + 标题」，取值仍走 `utils/cover.ts` 的同一套优先级
  （图片地址 → 渐变 → 哈希兜底）——本地/收藏/历史/搜索/歌单/详情六处列表同时受益；
- 本地封面走的是回环地址，属 `<img>` 类资源：应用 `csp: null` 不拦，实测正常显示。

### 4. 本地曲目不再问核心要歌词

打包版实测时日志里每次播本地文件都有一条 `catalog.lyrics ok=false 插件未安装：local`——
本地文件根本没有插件。`loadLyrics()` 改为**只对核心认识的插件源**问核心（`isCoreSource`），
并加两条假宿主断言（核心源会问一次 / 本地曲目一次都不问）。

### 5. 验证

| 验证 | 结果 |
|---|---|
| `pnpm verify` | **五道关卡全绿** |
| `pnpm smoke` | **287/287**（+2：核心源问歌词、本地曲目不问歌词） |
| `cargo test -p gently-core` | **212/212**（R38 +1：快照封面地址重新签发；R37 部分见上）；另有 **2 项 `#[ignore]`**：手工夹具生成器与 §11 性能测量） |
| `pnpm check:contract` / `check:reachability` | 契约一致（60 命令 / 8 事件 / 26 错误码）；可达性通过（服务节点 139 / 动作 65 / 界面 130；有意不做入口：服务 1 项 + action 1 项，**无未归档的死动作**） |
| **打包版实测** | 重建 release exe → 扫描 `%TEMP%\gently-e2e-cover`（mp3 内嵌**品红** PNG、FLAC 内嵌**青色** PNG、以及一个无封面 mp3）→ 逐像素核对缩略图：FLAC 行是**纯 (0,200,255)**、mp3 行是**纯 (255,0,255)**（都是内嵌图原色，不是渐变），无封面那行是逐像素变化的渐变；点击 mp3 行播放 → **播放条封面也是品红**，日志 `GET /cover/…png` 与 `媒体响应（本地文件） status=206 total=12945` |
| **打包版实测（重复路径自愈）** | 库里原有 5 行（同一文件两种拼法各一行）→ 用修好的便携版 exe 重扫一次：摘要 `移除 2`，库里只剩 3 行且路径全部是归一形式（`sqlite` 直接查询核对） |

证据：`release/screenshots/local-cover-both-formats.png`（mp3 品红 + FLAC 青色 + 无封面渐变，同屏）、
`release/screenshots/sidebar-group-collapsed.png` 与 `sidebar-group-expanded.png`（侧边栏折叠重构后照常）、
`release/screenshots/local-cover-list.png`（列表两种封面并存）、
`release/screenshots/local-cover-playing.png`（播放条用内嵌封面）、
`release/screenshots/portable-cover-heal.png`（便携版重扫：`移除 2`、重复行自愈、封面仍在）、
`release/screenshots/e2e-local-page.png`（改动前只有渐变缩略图，作为对照）。

### 6. 补记（同轮追加）：FLAC 的 PICTURE 块也进了自动化

上一段里 mp3 走的是**链式**元数据；FLAC 走的是**容器自己的** `format.metadata()`——合并逻辑的
另一半，原本只在真实文件上验证过（当时以为「FLAC 必须有合法音频帧」做不出离线夹具）。其实可以做：
STREAMINFO（固定块长 192 / 44.1kHz / 双声道 / 16bit）+ VORBIS_COMMENT + PICTURE，再加**一个**
CONSTANT 静音帧（帧头 4 字节 + 帧号 + CRC-8（poly 0x07）+ 两个 3 字节常量子帧 + CRC-16（poly 0x8005）），
symphonia 的 `resync` 就满意了。于是：

- 新增 `flac_picture_block_is_extracted_through_the_container_metadata_path`：FLAC 的标题/歌手/专辑
  （VORBIS_COMMENT）与封面（PICTURE）双双入库、代理回放的字节与图一致；
- **负向验证**：把合并循环砍成只读链式元数据 → 这个测试立刻红（说明它测的确实是容器那一路）；
- 顺带纠正一个我先前的错误结论：symphonia 的 isomp4 **支持** `ilst/covr` → `Visual`
  （第一次只在 `src/*.rs` 里 grep 漏了 `src/atoms/`），所以 `.m4a` 的封面本来也能读出来；
- 打包版里两种格式同时验收：FLAC 行的缩略图是**纯青色 (0,200,255)**、mp3 行是**纯品红 (255,0,255)**、
  无封面那行是渐变（逐像素核对，见 `local-cover-both-formats.png`）。

### 7. 补记（同轮追加）：守卫里那两条「没界面调用的 store action」结清了

`pnpm check:reachability` 每轮都打印「2 个 store action 没有界面调用」——提示归提示，放着就会腐烂：

- `ui.isGroupCollapsed`：一个**读形状的 action**，没人用，而 Sidebar 自己在三个地方各写了一遍
  `collapsedGroups.includes(...)`（AGENTS 第 15 条：同一算法只允许一份实现）。删掉 action，
  判定收成组件里的一处 `isCollapsed(key)`；
- `actions.player.stop`：**保留**并写进守卫的白名单——「停止」不是用户可见操作（播放/暂停是 `toggle`，
  播完/切歌各有自己的结算路径），但它是 store 的完整重置入口，冒烟测试用它复位状态后再断言解析器。
  为此给守卫加了 `DELIBERATE_ACTIONS`（与服务的 `DELIBERATE` 同源：**有意不做入口**才写，
  每次都打印理由；哪天真的接上界面会反过来提醒删掉）。现在守卫输出里没有无主提示了。
  打包版实测：点「我的收藏」分组标题 → 折叠（chevron 转向、条目与计数一起收起，「我的歌单」不受影响），
  再点一次 → 展开（`sidebar-group-collapsed.png` / `sidebar-group-expanded.png`）。

### 8. 补记（同轮追加）：把契约 §11 的性能预算量了一遍

契约写着「扫描 1 万文件 < 10s、FTS5 检索 P95 < 50ms」，此前从没量过。新增 `#[ignore]` 的测量测试
（`cargo test -p gently-core --test local_library -- --ignored --nocapture measure`，语料 1000 个真 WAV）：

| 指标 | 实测 | 外推 1 万文件 | 契约预算 |
|---|---|---|---|
| 首次扫描（读标签 + 入库） | 124 ms（0.12 ms/文件） | **≈1.2 s** | < 10 s |
| 重扫（大小没变 → 跳过读标签） | 21 ms（0.02 ms/文件） | **≈0.2 s** | —（R21 的优化项） |
| `local.list{query}` P95（200 次查询） | 1.11 ms | — | < 50 ms |

**如实说明口径**：语料是 1 秒的小 WAV、SSD、缓存热——真实曲库的 mp3/flac 读标签更贵、冷缓存更慢，
所以这两个外推值是**下界**；预算仍有 8×（扫描）与 40×（检索）的余量，结论是「预算站得住」。

**已知边界（如实记录）**：两条提取路径都有离线夹具——mp3（ID3v2/APIC，走**链式**元数据）
与 FLAC（PICTURE 块，走**容器**元数据，夹具里手写了一个合法音频帧：帧头 CRC-8 + 帧尾 CRC-16）。
`.m4a/.mp4` 与 `.ogg/.opus` 走的是与 FLAC 同一条路（symphonia 侧都支持），但没有各自的容器夹具
（造合法 MP4/Ogg 的成本高于收益）。夹具生成器留在 `#[ignore]` 的测试里
（`cargo test -p gently-core -- --ignored` 生成 `%TEMP%\gently-e2e-cover\`：mp3 品红封面、
FLAC 青色封面、一个无封面 mp3；同一个 `--ignored` 开关还跑契约 §11 的性能测量）。

## 已完成（第三十六轮）

### 1. 结论：界面确实会回到「已停」——是我把图标看错了

做法：从同一进程的两次截图里把**播放按钮区域**（`812,538` 起 56×46）裁出来，
用**最近邻放大 5 倍**并排放在一张图里（`release/screenshots/play-button-zoom.png`）：

| 时机 | 按钮 | 说明 |
|---|---|---|
| 点开曲目 1.6 秒后 | **‖**（暂停双竖条） | 正在播 |
| 播完（+7 秒） | **▶**（播放三角） | 已停 |

两张截图的哈希不同（`9AADA85B` vs `0A298DE7`），可见状态**确实变了**；
再往前那几张「看起来一样」的截图哈希相同，是因为它们**本来就都已经是播完之后的正确状态**——
我把 14px 的图标在缩小预览里读成了「暂停」。配合 R35 的日志证据
（`playback.report ok=true` + `recommend.feedback ok=true`），R35 的修复在界面侧也确认生效。

### 2. 两条方法论写进驱动脚本注释

1. **判断小图标别靠缩小后的预览图**：裁一小块 + 最近邻放大（`System.Drawing` 十来行，
   或直接用 `-Steps "shot:…"` 之后手工裁）比反复猜靠谱；
2. **「截图没变化」不等于状态没变**：`PrintWindow` 对 WebView2 偶尔返回上一帧。
   要先用 `move` 触发重绘、隔 1 秒连拍两张对比（本轮两次连拍一致，才敢下结论）。

### 3. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **285/285**、`pnpm check:contract` 一致、
`pnpm check:reachability` 通过（留白 1 项）、`cargo test -p gently-core` **202/202**。
证据：`release/screenshots/local-play-mid.png`（播放中）、`local-play-ended.png`（播完）、
`play-button-zoom.png`（两者按钮放大对照）。
## 已完成（第三十五轮）

### 1. 三行日志 + 一行诊断，把「没声音」拆成三种可能

- 核心媒体代理新增（以后排查播放问题直接看这三行）：
  `媒体连接已接受 peer=…` → `媒体请求 method=GET target=/m/<token>` → `媒体响应（本地文件） status=206 start=0 end=48044 total=48044 has_range=true`；
- 前端加了一个**临时**诊断：把 `<audio>` 的真实状态刷在播放条上
  （`rs/paused/t/d/err/time/ended/load/play` 计数器 + store 的 `playing/elapsed/repeat`），排查完即删。

### 2. 结论：音频其实**播完了**，我上一轮读错了

一次运行就看清（3 秒探针）：

```
rs=4 paused=true t=3.00 d=3.00 err=- cb=ok time=15/15 ended=1/1 load=1 play=1
playing=true elapsed=3.0 repeat=off
```

- `rs=4`（HAVE_ENOUGH_DATA）+ `t=3.00/d=3.00` → 字节取全、**播放到末尾**；
- `time=15/15` → 15 次 `timeupdate` **全部被消费**（store 的 `elapsed` 也确实到了 3.0）；
- `ended=1/1` → 结束事件送达且处理时没抛异常；
- 也就是说：**本地播放链路（核心代理 → WebView 解码 → 进度回写）完全正常**。
  上一轮「进度不前进」是我把「已经播完」误读成了「没在播」——探针只有 3 秒，
  截图时它早结束了，剩下的是一个**错误状态**（见下）。

### 3. 真正的 bug：队列最后一首播完**不结算**

- `next()` 在「没有下一首」（`moveTo` 返回 false）时只做 `patch({playing:false, elapsed:0})`，
  既不调 `playback.report`（播放历史 / 推荐画像看不到这一次播放），也不报
  `recommend.feedback complete`（**最强的正反馈就这么丢了**）；
- 更糟的是它把「播完」和「暂停」记成同一件事，界面因此停在错的状态上（就是第 2 节那张图）；
- 修法：队列到头时先 `reportPlayback({final: true})`（历史 + `recommend.feedback` 一起走
  `reportFeedback`），再置 `playing:false`；
- 修后真实应用：3 秒探针播完 → 日志 `playback.report ok=true` + `recommend.feedback ok=true`。

### 4. 打包版实测（干净构建）

```
playback.resolve ok=true → 媒体连接已接受 peer=127.0.0.1:59004 → 媒体请求 GET /m/<token>
→ 媒体响应（本地文件）status=206 start=0 end=48044 total=48044 has_range=true
（+3.5s，3 秒探针播完）→ recommend.feedback ok=true → playback.report ok=true
```

即：**本地文件真的播完了**，历史与推荐反馈都落库。

**一个观察（下一轮可查）**：截图里播放条仍显示暂停图标，但 `PrintWindow` 对 WebView2 偶尔返回上一帧
（这次截图的哈希与更早一张完全相同，而同一次运行的日志明确发生了结算），所以「界面是否还停在播放态」
这次没有可靠结论。下一轮用「先 move 触发重绘、隔 1 秒连拍两张」再确认。

### 5. 验证

`pnpm smoke` **285/285**（+1：最后一首播完要结算历史与推荐正反馈）、`pnpm typecheck` 通过、
`cargo test -p gently-core` **202/202**、`pnpm check:contract` 一致、`pnpm check:reachability` 通过；
真实应用（干净 release 构建 + 便携版重打包 `19a7e248…d635`）：`媒体响应 206 全量` →
`recommend.feedback ok=true` → `playback.report ok=true`。
临时诊断代码已全部删除（`audio.service` 与 `PlayerBar` 各清一遍，搜 `audioDebug` / 计数器为空）。

## 已完成（第三十四轮）

### 1. 真实应用抓到 R29 的回归：本地音乐播不响

- 复现：扫描一个真 WAV（3 秒 440Hz）→ 本地音乐页出现 `gently-tone` → 点行播放；
- 症状：界面进入播放态（行高亮、暂停图标），但**日志里没有 `playback.resolve`**、也没有回环代理启动，
  进度不动——即「看起来在播，其实什么也没发生」；
- 根因：R29 把 `catalogService.resolveUrl` 改成**按源路由**（`isCoreSource(id)` 才问核心），
  而 `local` 是核心自带的**伪源**（M3c：`playback.resolve` 认 `local:` 前缀，把文件挂到回环代理上），
  它不在 `plugin.list` 里 → 判定为「前端源」→ `getMusicSource('local')` 找不到 → 返回 null →
  播放器退回静音模拟时钟。**网络源一切正常，只有本地音乐这条路径坏了**；
- 修法：`core.sources.ts` 拆出两个判定，各管一段：
  - `isCoreSource(id)`：核心**认识的插件**——用于目录类命令（搜索 / 榜单 / 详情 / 推荐）的按源路由；
  - `isCorePlayableSource(id)`：**能交给核心播放**的源 = 装好的插件 ∪ `local` ——只用于 `resolveUrl`。
  两者混用就会重犯这次的错误（把 `local` 塞进目录路由会让搜索白问核心，把 `local` 排除在播放外就是这次的回归）；
- 修后真实应用：日志 `INFO 本地流代理已启动（仅回环） port=55975` + `DEBUG dispatch command="playback.resolve" ok=true`，
  界面进入播放态。冒烟补 2 项（本地文件交给核心解析、演示源不走核心）。

### 2. 顺手修驱动脚本：别把 16×16 的辅助窗口当主窗口

上一轮起，脚本偶尔截出 **16×16** 的图（点哪都没反应）——启动早期进程里只有一个 16×16 的辅助窗口，
`LargestWindow` 就把它当目标了。现在要求窗口 **≥ 400×300** 才认，否则继续等到超时。

### 3. 留一个待查（下一轮）：打包版里本地播放的进度不前进

- 事实：解析成功（`playback.resolve ok=true`）且界面在播放态，但
  **进度不动**：既没有音频引擎的 `timeupdate` 回写，`usePlayerEngine` 的回退时钟也没跑
  （`playable === true` 时它故意不跑）；等 12 秒截图与等 7 秒的截图**逐字节相同**；
- 这意味着「WebView 真的开始播放」这一环没走通，候选原因（下一轮按序排查）：
  1. `<audio>` 的 `play()` 被自动播放策略挡下（`audio.service` 的 catch 会走 `onError` → 回退时钟，
     但我没看到回退时钟接手，说明错误也没触发）；
  2. 回环代理的响应让 `<audio>` 停在 `loading`（例如 token/`Range`/`Content-Type`），
     既不出 `timeupdate` 也不出 `error`；
  3. WAV 在 WebView2 里解码失败（但那样 `error` 事件应该会来）；
- 排查手段（下一轮直接用）：在核心侧给媒体连接加一条 `INFO` 级「已接受连接 / 请求行」日志，
  就能确定 WebView 到底有没有来取字节；再用 `pnpm ui:capture` 在**同一个进程**里长等（如 30 秒）看状态变化。

### 4. 验证

`pnpm smoke` **284/284**（+2）、`pnpm typecheck` 通过、`pnpm check:contract` 一致、
`pnpm check:reachability` 通过（有意留白 1 项）、`cargo test -p gently-core` **202/202**；
真实应用：本地曲目 → `playback.resolve ok=true` + 回环代理启动。
## 已完成（第三十三轮）

### 1. 把上一轮的假疑点查清：是我自己的坐标错了

我一度把这记成疑点。查清了：**应用没问题，是我算错了坐标**。

- **悬浮对照法**：光标移到「重载」上截图，与基线比有 **1432 个像素差**（ghost 按钮 hover 会变色）；
  移到「卸载」上则 **0 个像素差**——那个位置根本没有按钮；
- **像素亮度列扫描**量出这一行标签的真实范围：
  `302..325 上移｜360..383 下移｜418..440 启用｜476..499 重载｜534..593 凭据与配置｜628..651 卸载`
  ——「卸载」中心在 **x≈640**，而我按肉眼估的 668~684 落在按钮右边；
- 按 640 重点：二次确认弹窗正常出现（「卸载音源插件 / 「本机验证音源」将被卸载，其数据不再参与聚合与回退。/ 取消 · 确定」），
  点「确定」后 `plugin.remove ok=true`，`%APPDATA%\com.xun.gently\plugins` 恢复为只有 `.hosts`——
  **夹具插件彻底清掉，用户数据无残留**。

**教训**：驱动界面的坐标不要靠肉眼估，用像素亮度扫描量（或先 hover 比对）。
差点把「我自己点偏了」记成产品 bug——这条也写进了 `capture-window.ps1` 的注释。

### 2. 顺手消掉一处分区措辞的歧义

插件页顶部小标题写「音乐源以插件形式接入，共 5 个」（5 = 核心插件 + 内置示例源），
而导入面板里的分区写作「已安装插件 / 还没有安装任何插件」——同一页上两句话看起来自相矛盾。
现在分区改为「**已导入的插件（核心）**」，空态改为「还没有导入任何插件；内置示例源见下方列表。」
（纯文案，zh + en 同步；下方表格本来就用「内置」徽标区分来源。）

## 已完成（第三十二轮）

### 1. 自写夹具插件（不进仓库，临时目录）

- 头部元数据（`@name/@id/@version/@hosts/@qualities` 等）+ 6 个顶层函数
  （`search` / `getTrackInfo` / `getTopLists` / `getTopList` / `getLyric` / `getMediaSource`），
  返回固定两条曲目，**封面用一段 data URI 品红 PNG**——离线也能显示，而且颜色一眼可辨，
  于是「封面到底来自插件还是哈希兜底」不用猜；
- 先用仓库自带的作者自测 CLI 验一遍：`cargo run -p gently-core --bin plugin-tool -- check <file.js>`
  → `✓ id=gently-probe-source ... 能力=[Search, GetMediaSource, GetTrackInfo, GetLyric, GetTopLists, GetTopList]`。
  （这一步也顺带证明「作者自测 CLI」这条路是通的。）

### 2. 真实应用里的完整链路（截图在 `release/screenshots/probe-*.png`）

驱动脚本走完：插件管理 → 本机路径 → **单文件** → 填路径 → 检查（预览：名称/描述/权限「无需额外权限」）
→ 勾选同意 → 安装 → 搜索「验证」→ 点第一行播放。日志按时间顺序给出全部命令：

```
plugin.preview ok=true → plugin.import ok=true → plugin.reload ok=true
catalog.search ok=true → catalog.lyrics ok=true → catalog.track ok=true → playback.resolve ok=true
```

界面结果：来源筛选出现「本机验证音源」、搜索结果「共 2 首」（验证曲目 Alpha / Beta）、
播放条显示 **插件给的品红封面**（= R31 的 `catalog.track` → `player.detail` → CSS 真的连通了）。
插件管理里「启用/禁用/重载」也都在真实应用里点过一遍（禁用后徽标变「已禁用」、按钮变「启用」）。

**一个操作失误也值得记下**：路径模式的形态选择默认是「压缩包」，我第一次没切到「单文件」，
核心如实回了 `plugin.invalid_source`（不是可读的 zip）——错误提示准确，是我的操作错了。

### 3. 修掉竞态：**搜索在本地插件上永远卡住**

- 症状：装好插件后搜索「验证」→ 界面 `[验证] 共 0 首` 且表格一直「加载中…」，20s 后才收敛为空；
  日志里 `catalog.search ok=true`，但**没有** `catalog.search.partial/done` 的效果；
- 根因：前端原来「先 `invoke catalog.search` 拿 searchId，再 `listen` 订阅事件」。
  本地插件几乎瞬时返回，核心在命令返回前后就把 `partial`/`done` 推出去了——
  这段窗口里前端还没订阅，事件直接丢；网络插件要几百毫秒，所以这个竞态长期没被触发；
- 修法（`core.catalog.ts` 的 `coreSearch`）：**先订阅两条事件、再发命令**；
  订阅窗口内到达的事件先进 `buffered` 队列，拿到 `searchId` 后按序补投；
  中止/超时路径照旧（`signal` 在订阅前就被检查一次，命令返回后再查一次）；
- 效果：同一条搜索，修前「共 0 首 + 加载中」，修后「共 2 首」并正常播放。

### 4. 冒烟：竞态回归用例 + 假宿主的一个假阳性

- 新增用例：假宿主在 `catalog.search` **返回之前**就推 `partial`+`done`，断言搜索仍能兑现
  （修前必然超时）；
- 顺带修掉假宿主 `waitForSubscription` 的假阳性：它查的是 `subscribedEvents`（**追加历史**），
  于是**上一轮**的订阅会让这一轮的等待立刻通过（这也是竞态用例第一次跑失败的原因）。
  现在按 `activeEvents()`（当前仍生效的订阅，退订会移除）判断；`subscribedEvents` 只用于「事件名合法」的断言；
- 假宿主 `handler` 多拿一个 `host` 参数（在处理器里推事件不再靠闭包外的变量）。

### 5. 验证

`pnpm smoke` **282/282**、`cargo test -p gently-core` **202/202**、`pnpm check:contract` 一致、
`pnpm check:reachability` 通过（有意留白 1 项）；真实应用里跑通安装→搜索→播放→详情→歌词。

## 已完成（第三十一轮）

### 1. 曲目详情接上：播放时补一次源侧元数据（`catalog.track`）

- **为什么值得接**：列表里的曲目快照常常只有标题歌手（搜索结果、榜单行都这样），
  于是播放条与歌词页的封面退到「哈希渐变」；真实插件在 `getTrackInfo` 里给的封面/专辑白拿不用，
  有点浪费——这正是当初把它列进留白的原因（「列表/播放条已用快照渲染」），
  但「有更好的封面可用」比「形状够用」更有价值；
- **实现**：`catalogService.fetchTrackDetail(track)` 按**源路由**（核心认识的源才问核心，
  内置演示源没有详情端点 → 返回 `null`，界面继续用快照）；`player.slice` 在 `start()` 里
  **异步**取详情（`loadDetail`，与歌词同一套「切歌后丢弃过期结果」的 `playId` 守卫），
  `player.detail` 存下来；播放条与 `/now-playing` 用 `detail ?? current` 渲染封面；
  切歌/停止清空 `detail`（上一首的封面绝不能留在这一首上）；
- 失败语义沿用 `detail()`：源没实现（`common.not_implemented`）与源没装（`common.not_found`）
  都是正常情况，静默退回快照；其它错误留 `console.warn` 痕迹。

### 2. 守卫白名单缩到 1 项（它自己提醒的）

- `pnpm check:reachability` 在接线后打印 `note 白名单里的 coreTrackDetail 已经接上界面了（请从 DELIBERATE 移除）`
  ——照办后白名单只剩 `library.history.push`（写历史统一走 `playback.report`，前端不该双写）；
- 服务节点 137 → **138**（新增 `fetchTrackDetail` 这一层），界面文件 130。

### 3. 验证

`pnpm smoke` **281/281**（+3：播放核心源的曲目会问一次详情且引用是 `source:trackId`、
详情封面写进 `player.detail`、演示源曲目不问核心且切歌清空详情）、
`pnpm check:reachability` 通过（有意留白 1 项）、`cargo test -p gently-core` **202/202**、
`pnpm check:contract` 一致。

**如实说明**：本机没装插件，演示源没有详情端点 → 打包版里看到的行为与之前一致
（封面仍走渐变/快照）；这条链路由假宿主断言覆盖（真插件给封面时才会显现差异）。
「在真实打包版里装一个插件跑通」是下一轮的主要目标。

## 已完成（第三十轮）

### 1. 新工具：`scripts/capture-window.ps1`（`pnpm ui:capture`，仅 Windows）

- **截图**：`PrintWindow(PW_RENDERFULLCONTENT)`——WebView2 是 GPU 合成的，不传这个 flag 会抓成空白；
  窗口句柄用 `EnumWindows` 取「进程里面积最大的可见顶层窗口」（`MainWindowHandle` 有时指到 16×16 的隐藏窗口，
  第一版就抓到一张 16×16 的图）；
- **驱动**：`SetForegroundWindow` + `SetCursorPos` + `mouse_event` + `keybd_event`，
  步骤化语法 `-Steps "click:x,y;move:x,y;paste:文本;enter;key:0xNN;wheel:-600;wait:秒"`。
  粘贴走剪贴板（中文路径也能用）；滚轮要先 `move` 到内容区（滚轮作用于光标下的元素——
  第一次把鼠标停在侧边栏上，页面纹丝不动）；
- **`-AssertRendered`**：抽样像素颜色数 < 5 判定「白屏」并退出码 1——「打包版不是白屏」从此可自动断言
  （实测 165 种颜色）；
- 不外传二进制：截图落在 `release/screenshots/`（与 zip 同一处，属开发产物）。

### 2. 第一次「看着真实应用」验收（证据在 `release/screenshots/`）

| 截图 | 确认了什么 |
|---|---|
| `ranking-dark.png` | 深色排行榜：分类树、分源筛选（全部音源 / 内置示例源 / 模拟音源 B、C）、榜单行与渐变封面 |
| `local-scan-result.png` | **R28 的扫描面板真的能用**：填目录 → 「扫描 1 个文件，新增 1，更新 0，移除 0，跳过 0，读不了 0」→ 表格出现 `gently-probe`（真 WAV，时长 0:01，无标签时标题退回文件名） |
| `scan-removed-on-rescan.png` | 删掉文件再扫一次 → 「移除 1」并回到空态（「清理只针对本次扫描范围」的语义在真实应用里成立） |
| `recommend-source.png` | 推荐页「为你推荐」（画像含刚扫进来的本地曲目 + 理由 chip）与 **「来自当前音源」**（R29 新增一栏）；悬浮卡片出现「不感兴趣」× |
| `theme-light.png` | 浅色主题整体可读（侧边栏 / 标签 / 分类 chip / 表格 / 播放条） |
| `search.png` | 搜索「南」→ 命中 2 首，表格与分源筛选正常 |

### 3. 顺带拿到的运行时证据（R27 事件名修复）

- 打包版日志：`library.local.scan ok=true`（`scanned=1 added=1`）→ 随后 `library.local.list`（强制重读）；
- **没有任何 `事件推送失败`**——核心的 `local_library.rs` 在扫描结束时**无条件**推一条
  `library:scan:progress`（第 135 行），它真的发出去了；这正是 R27 之前会失败的那条 emit 路径，
  所以「点号事件名导致事件全丢」的修复在真实 Tauri 上得到了运行时确认（此前只有 Tauri 源码规则 + 三层测试）。

### 4. 顺带说清的两件事

- 表格在该窗口宽度（916 px）下出现横向滚动条是**预期行为**（列宽合计大于容器），不是布局 bug；
- 验证用的探针曲目已在第二次扫描时移出曲库（`移除 1`），没有在用户数据里留下垃圾。

### 5. 全页面视觉走查（同轮补做，证据在 `release/screenshots/`）

工具跑通后把没看过的页面一次看完，没有发现视觉缺陷（这条结论以前只能靠「应该没问题」）：

| 截图 | 确认了什么 |
|---|---|
| `setting-diagnostics.png` | 设置页「本机核心」诊断卡：已连接核心 / 版本 v0.1.0 / windows-x86_64 / 数据库已就绪 / **凭据存储 windows-credential-manager（已接入系统凭据库）** / 条目统计（插件 0 · 收藏 0 · 曲目 0 · 下载 0）/ 数据目录与日志目录（可一键打开） |
| `theme-market.png` | 主题市场：分类筛选（全部/配色/深色/密度/圆角/效果/字体）、皮肤卡（当前「暮光紫」标「使用中」）、导入/导出按钮 |
| `download-empty.png` | 下载管理：下载中/已下载两个页签、清理已完成（无完成任务时禁用）、空态「暂无下载任务」 |
| `favorites-empty.png` / `recent-empty.png` | 收藏与最近播放的空态 |
| `ranking-dark.png` | 深色排行榜（收尾时把主题切回深色，未改变用户原有偏好） |

### 6. 驱动脚本自身的两个坑（都已修）

1. **遗留进程**：开发机上留着上一轮没杀掉的 `gently.exe`，脚本挑到旧窗口 → 「点了没反应、截图全是老页面」
   （第一次 sweep 八张图**哈希完全相同**才发现）。现在 `-Launch` 会先杀干净，并取**最新启动**的进程；
2. **滚轮作用于光标下的元素**：光标停在侧边栏上滚页面纹丝不动；现在文档里写明要先 `move` 到内容区。
   顺带把实测坐标做成「界面地图」写在脚本注释里（标题栏/侧边栏/播放条三组），下次驱动不用再量。

### 7. 验证

`pnpm verify` 五道关卡全绿：`pnpm smoke` **278/278**、`pnpm check:contract` 一致、
`pnpm check:reachability` 通过、`cargo test -p gently-core` **202/202**；
打包版启动 0 警告；`pnpm ui:capture -AssertRendered` 退出码 0（169 种颜色）。

## 已完成（第二十九轮）

### 1. 新增「界面可达性」守卫（`scripts/check-reachability.mjs`）

- 动机：契约守卫查「每条命令有没有前端封装」，但那不等于用户能用——R28 的
  `library.local.scan` 全链路都在、界面却没有入口。这类洞必须能被机器发现；
- 做法：静态解析三层节点——服务节点（`export function coreX` / `export const libraryService = {…}` 的方法，
  含注释后的成员与 `{load}` 简写）、动作节点（`const actions: XActions = {…}`，简写去同文件找局部定义，
  并把局部函数体递归并进来），再按「界面文件 → 动作 → 服务 → 服务」算不动点可达性；
- 三个让判定准确的细节（都是被自己的**负向测试**逼出来的）：
  1. **函数体**要先配对参数括号再配花括号——`options: {limit?: number} = {}` 会让「函数体」变成参数类型
     （第一版因此把 `coreCancelSearch` 报成没人用）；
  2. **解构不等于调用**：`const {load, scan} = useActions().library;` 里的名字要剥掉
     （否则删掉调用点照样算可达——负向测试立刻暴露）；但**别名要记住**
     （`const {add: addDownload} = …` 只出现别名，不记就漏）；
  3. 动作可能被**当回调传**（`onClick={next}` / `{onConfirm: clearRecent}`），只找 `name(` 会漏掉整个播放器；
- 白名单 `DELIBERATE` 只放**产品取舍**并写理由，每次运行都打印（接了界面会提示移除，防止腐烂）；
- 负向测试：把扫描面板的 `scan(...)` 换成别的 action → 守卫立刻报
  `libraryService.scanLocal → library.local.scan` 并以 1 退出（证明它真能拦住 R28 那类洞）；
- 接进 `pnpm verify`（现在是**五道关卡**：类型 / 冒烟 / 契约 / 可达性 / 核心单测）。

### 2. 它抓出来的洞一：推荐负反馈（`recommend.feedback`）从没被调用

- 核心的 `build_taste` 消费 `like / unlike / skip(<0.5) / complete(≥0.9)`，但**只消费播放次数与时间**
  ——「听 5 秒就切走」在画像里和「完整听完」没有区别，不显式上报就永远学不到负信号；
- 播放器（`player.slice`）新增结算反馈：**切歌 / 停止 / 播完**时按进度报 `skip(<0.5)` 或 `complete`；
  **暂停不算倾向**（去接个电话不该压低这首歌的权重），因此单独用 `feedbackPlayId` 去重
  （历史那条 `reportedPlayId` 可能已被暂停路径消费）；
- 推荐页每个卡片新增「不感兴趣」= `skip` + `progress: 0`（契约里唯一的显式负反馈动作）
  + **立刻从列表移除**（用户的动作必须马上看得见）；
- 卡片结构顺带修正：原来是整块 `<button>`，塞不下第二个操作——改成「容器 + 主按钮 + 次按钮」
  （按钮套按钮是无效 HTML，键盘与读屏都会错乱）。

### 3. 它抓出来的洞二：源侧推荐（`catalog.recommend`）没有入口，且路由有隐患

- 推荐页新增「**来自当前音源**」一栏：插件自己的 `getRecommend`（它知道自己的榜单与热度，
  是本机画像算不出来的），与本机画像推荐并列；源没实现或跑挂 → 这一栏直接不显示；
- `catalogService.fetchRecommendFrom` 原来是**同步挑前端注册表**的插件：桌面上选中的是核心的源时，
  `getMusicSource(id)` 找不到就 `?? getActiveMusicSource()` → **静默退回演示源**（和 R27 修过的
  `searchIn` 是同一个坑）。现在按源路由：核心认识的源走 `catalog.recommend`，演示源走本地实现，并统一裁到 `limit`。

### 4. 它抓出来的洞三：`libraryService.setPluginPriority` 没人用

- 插件页的「上移/下移」直接调 `corePlugin.setPriority`，绕过了服务层的 `isCoreSource` 守卫——
  内置演示源（核心不认识）会被白挨一条 `common.not_found` 并弹错；现在改走服务层（返回信封，界面照旧显示错误）。

### 5. 验证

`pnpm smoke` **278/278**（+11：源侧推荐走核心、`dislike` 上报 `skip`+0 并移除、暂停/切歌/播完三种结算的反馈、
源侧推荐浏览器兜底、卡片移除）、`cargo test -p gently-core` **202/202**、`pnpm check:contract` 一致、
`pnpm check:reachability` 通过（服务节点 138 / 动作节点 66 / 界面文件 130，有意留白 **1** 项：
`library.history.push`，理由写在脚本里）。

## 已完成（第二十八轮）

### 1. 发现的洞：功能全在核心里，界面没有入口

- `library.local.scan`（本地曲库唯一入库入口）**没有任何界面调用**：`coreScanLocal` 只被
  `services/index.ts` 导出，`views` / `store` 里搜不到 `scan`。桌面上 `library.local.list` 返回空，
  而 mock 只在浏览器出现 → 「本地音乐」页永远空着，用户以为功能不存在；
- 教训写进 ROADMAP：契约守卫查「有没有前端封装」，查不到「有没有界面入口」。
  一条命令被封装 ≠ 用户能用——这类洞只能靠**照着用户路径走一遍**发现；
- 顺带说明一个更早的承诺：风险清单里写着「零插件时应用本身可用（本地文件播放/歌词/皮肤/本地库）」——
  在扫描入口做出来之前，这句话里的「本地库」其实不成立（用户没法把音乐加进来）。现在成立了。

### 2. 修法：本地音乐页常驻扫描面板（`views/local/components/ScanPanel.tsx`）

- **多目录**：每行一个路径（核心的 `dirs` 本来就是数组）；`包含子目录` 开关映射 `recursive`；
- **进度**：新增 `coreListenScanProgress`（订阅 `library:scan:progress`，订阅失败不影响扫描本身），
  store 里 `scanning / scanProgress / scanSummary / scanError` 四个字段，扫描结束自动退订并清空进度；
- **结果如实说明**：「扫描 12 个文件，新增 3，更新 1，移除 0，跳过 8，读不了 0」——
  比「完成」有用；失败按错误码走 i18n（`library.scan_failed` 等），不显示开发者字符串；
- **结束后强制重读列表**（`library.load({force: true})`）：扫描的成果必须立刻出现在页面上；
- 路径**手填/粘贴**而不是系统文件选择器：原生选择器需要 `tauri-plugin-dialog`，它不在本机离线
  crate 缓存里（与 MSI/WiX 同一类环境限制），面板上如实写明，不给一个点了没反应的按钮；
- 浏览器预览显示一行「扫描需要桌面端」，空态文案也改成「填入音乐目录并扫描」。
- i18n 新增 11 个键（zh + en），`LocalScanResult` 从内联类型提成契约命名类型（`src/api/index.ts`）。

### 3. 假宿主补成**能推事件**，事件链路第一次进冒烟

- 冒烟原来只替换 `window.__TAURI_INTERNALS__.invoke`，因此**事件订阅一测就崩**
  （`@tauri-apps/api/event` 还要 `transformCallback`），事件路径一直是盲区；
- 现在照 Tauri 的语义补全（`transformCallback` / `unregisterCallback` / `runCallback`、
  `plugin:event|listen` / `unlisten`、两种 `invoke` 调用形态、Node 里缺的 `window.setTimeout`），
  并暴露 `host.emit(event, payload)`、`host.subscribedEvents`、`host.invalidEvents`；
  `plugin:event|listen` **按 Tauri 的字符集规则校验事件名**——名字非法即抛错并记录；
- 于是这些终于被断言：
  1. **下载事件**：`download:progress` → 状态/进度、`download:done` → 路径与 100%、
     `download:error` → 错误码（界面按码本地化）；
  2. **流式搜索**：`catalog:search:partial` 触发 `onPartial`、`catalog:search:done` 兑现 Promise；
  3. **扫描进度**：`library:scan:progress` 进 state（进行中写入、结束后清空）；
  4. **事件名合法性**：前端订阅过的名字必须在 `CORE_EVENTS` 里且字符集合法
     ——R27 那个「点号事件名」的 bug 现在会直接让冒烟失败。

### 4. 统一「mock 什么时候能出现」：只在**没有核心**时

- `coreLoadX()` 返回 `null` 有两种含义：「没有核心」与「核心报错了」，
  而 `libraryService` 原来把两者都当成「退回 mock」——核心在却读失败时，
  用户会看到**示例数据冒充自己的收藏/歌单/本地库/下载**（比空列表糟糕得多）；
- 现在全部按 `coreAvailable()` 分流（`loadLyrics` 一直是这么做的）：核心在 → 返回核心给的（哪怕为空），
  没有核心 → 才退回 mock；浏览器预览行为不变；
- 假宿主新增 2 项断言：核心报错时本地曲库/收藏/歌单为空，而不是 mock 数据。

### 5. 验证

`pnpm smoke` **267/267**（+20：事件链路 11 项、扫描链路 7 项、mock 回退策略 2 项）、
`cargo test -p gently-core` **202/202**、`pnpm check:contract` 一致（60 命令 / 8 事件 / 26 错误码）；
核心侧的扫描语义（只认音频扩展名、大小未变不重读、清理只针对本次范围、`library:scan:progress`）
在 `core/tests/local_library.rs` 与 `core/tests/e2e_chain.rs` 里本来就有覆盖。

## 已完成（第二十七轮）

### 1. 根因：事件名带点号，Tauri 一律拒绝（**所有事件静默丢失**）

- 触发点是打包版启动实测的日志：搜索一次就会出现
  `WARN 事件推送失败 event="catalog.search.partial" err=only alphanumeric, '-', '/', ':', '_' permitted for event names`；
- Tauri 的事件名校验是 `chars().all(|c| c.is_alphanumeric() || c == '-' || c == '/' || c == ':' || c == '_')`
  （`tauri-2.11.5/src/event/event_name.rs`，`EventName::new` / `Deserialize` 都走它），
  所以契约里 `catalog.search.partial` / `download.progress` / `library.scan.progress` 这类名字**一个都发不出去**；
- 为什么一直没被发现：`TauriEventSink::emit` 把错误降级成 `tracing::warn!`（「事件丢一次由后续请求补齐」），
  命令返回值一切正常 → 单测（假 sink）、冒烟（浏览器 + 假宿主）全绿，只有**真的在桌面上搜一次**才暴露；
- 症状清单（全部由这一条引起）：流式搜索的 `partial`/`done` 都收不到 → 搜索页只能等 20s 超时；
  下载进度/完成/失败事件收不到 → 进度条不动、失败原因不显示；扫描/导入进度、`plugin:health` 同理。

### 2. 修法：契约名改冒号分段，并把字符集约束钉在三层

- **契约名与传输名保持同一个字符串**（不引入「逻辑名 ↔ 传输名」的第二套映射，避免两处漂移）：
  `catalog:search:partial` / `catalog:search:done` / `download:progress` / `download:done` /
  `download:error` / `plugin:health` / `plugin:import:progress` / `library:scan:progress`；
  改动面：`core/src/events.rs`、契约 §3、`src/api/index.ts` 的 `CoreEventMap`、核心测试里的 14 处字符串、文档与注释；
- **运行时常量收口**：新增 `src/services/core.events.ts` 的 `CORE_EVENTS`（`satisfies Record<CoreEventName, CoreEventName>`
  → 契约里加/改事件而这里没跟上，`tsc` 直接失败），`core.catalog.ts` / `core.download.ts` 不再写字面量；
- **三层守卫**：
  1. `core/src/events.rs` 新增 2 项单测：`names_are_transport_safe`（字符集，注释里写明点号这个坑）、`names_are_unique`；
  2. `scripts/check-commands.mjs` 的事件比对从「文档 ↔ Rust」升级为**四处一致**
     （文档 §3 表格 ↔ `events::ALL` ↔ `CoreEventMap` 键 ↔ `CORE_EVENTS` 值）+ 字符集检查；
  3. `pnpm smoke` 新增纯函数断言：`CORE_EVENTS` 的 8 个名字都落在 `EVENT_NAME_PATTERN` 里。

### 3. 同类问题：桌面端的**源路由**（演示源不该去问核心）

- 日志里还有 `WARN dispatch command="catalog.topLists" ok=false code="common.not_found" 插件未安装：mock`：
  桌面上真正干活的音源在核心里，而**内置演示源只活在前端注册表**（`src/plugins/builtin`）；
  之前 `catalogService` 只看「有没有核心」就发 `catalog.topLists`，于是**核心里一个音源都没装**（新装机的正常状态）
  被显示成一条故障提示，连演示数据都看不到；
- 新增 `src/services/core.sources.ts`：`plugin.list` 的进程内缓存（`rememberCoreSources` + TTL 5s 的
  `ensureCoreSources`，用户直接进搜索页也不会因为「没打开过榜单页」而误判）+ `isCoreSource` / `coreSourceIds`；
- `catalogService` 全部**按源**路由：核心认识的源走核心，演示源走本地实现；
  `searchAll` 两类源并行跑（核心带 `sources` 只搜它自己的源），核心里一个可用源都没有时不再空等；
  `searchIn` 对核心源**绝不静默退回演示源**（那比报错更糟：用户以为在搜 A 源，拿到的是演示数据）；
  核心回 `common.not_found` 时按「核心不认识这个源」处理（路由表过期/插件刚卸载），退回本地实现而不是报故障；
- `libraryService.loadPlugins()` 现在把**核心插件 + 内置演示源**一起交出来（演示源标 `builtin`，不可卸载），
  并且只有核心认识的 id 才发 `plugin.setEnabled/setPriority/remove`（不再刷出无意义的 `not_found`）；
- 假宿主回归 7 项（新增）：插件列表两类共存且无重复 id、演示源不问核心也能拿到分类树与内容、
  核心源的按源搜索失败返回空而不是演示数据、演示源照常返回本地结果、
  「核心回 `not_found`」时退回本地实现而不是报故障、路由表与核心不一致时的兜底。

### 4. 顺着同一条线索找到的第三个「静默失败」：下载

- `download.slice.add()` 原来是 `libraryService.createDownload(track).then((created) => { if (!created) return; ... })`，
  而 `coreCreateDownload` 把核心的失败压成 `null`——于是桌面端点「下载」在核心拒绝时
  **什么都不发生**（没有任务、没有提示）：典型场景正是①里的演示源曲目（核心回 `插件未安装：mock`）；
- 服务层改成返回**信封**（`coreCreateDownload` → `CoreResult<DownloadTask>`），切片据此分三路：
  成功 → 插核心任务；`common.unsupported_platform`（浏览器预览）→ 走模拟进度；
  **其他失败 → 插一条 `status: 'error'` + `errorCode` 的任务**，下载页本来就会把错误码渲染成本地化原因；
- 顺手修掉一个隐藏 bug：`add()` 用 `load()` 时的快照 `coreDriven` 决定要不要插模拟占位，
  而 `load()` 之前点下载时快照还是 false → 会**同时**插一条假任务、又收到核心的真任务（同一首歌两条）；
  现在只看「有没有核心」（`coreDownloadsAvailable()`）；
- 「重试」语义对齐：本地兜底项的 id 是 `dl:<track.id>`（核心的是 `dl-<毫秒>-<序号>`），
  有核心时 `resume()` 对本地项 = 移除后**重新向核心建一次**（用户可能刚把插件装好），
  而不是把状态改成「下载中」再配一个假速度（那是撒谎）；
- 假宿主回归 3 项：错误任务带错误码、重试会真的再建一次、以及断言用的空闲曲目。

### 5. 验证

`pnpm smoke` **247/247**（+11：事件名 1 项、假宿主源路由 7 项、下载失败呈现 3 项）、
`cargo test -p gently-core` **202/202**（+2 事件名单测）、`pnpm check:contract` 一致
（事件从 2 处比对升为 4 处）；release 重新构建 + 便携版重新打包（`d0b12bfe…7a1e`）。

**打包版实测（同一台机、同一个数据目录，修前 vs 修后）**：

| 启动实测 | 修前（04:13，R26 的 exe） | 修后（04:23 / 04:28，本轮 exe，两次启动） |
|---|---|---|
| `catalog.topLists` / `catalog.topList` | 两条 `WARN ... 插件未安装：mock`（把「核心里没装音源」显示成源故障） | **0 条**——演示源不再去问核心 |
| 其他警告 | 搜索时的 `事件推送失败`、`搜索已结束或不存在` | 启动路径 **0 条警告** |
| 命令链路 | `plugin.list` / `skin.list` / `library.*` / `system.status` 全 `ok=true` | 同上，全 `ok=true` |

事件名这一条要**真的在界面上搜一次**才会进日志（启动路径不发事件），因此：
- 传输层的判定依据是 Tauri 自己的校验规则（`tauri-2.11.5/src/event/event_name.rs`：
  `is_alphanumeric() || '-' || '/' || ':' || '_'`），8 个事件名现在全部落在字符集内；
- 这个约束被三层拦住：`core/src/events.rs` 的 `names_are_transport_safe` 单测、
  `scripts/check-commands.mjs` 的字符集检查（文档 ↔ Rust ↔ 前端类型 ↔ 前端常量）、
  `pnpm smoke` 对 `CORE_EVENTS` 的断言——以后再出现点号事件名会直接失败。

## 已完成（第二十六轮）

### 1. 根因：测试之间**没有真正隔离**
- 每个测试的临时目录名是「前缀 + 进程 id + `SystemTime::now()` 的纳秒」拼的。
  Windows 上系统时钟粒度约 **15ms**，而 cargo 默认**并行跑测试**——同一进程里两个测试
  完全可能拿到同一个纳秒值，于是共享同一个数据目录与同一个 `gently.db`：
  一个测试写下的订阅索引/插件配置被另一个测试读到（`count: 1` 而不是 0、`revision: 2` 而不是 0）；
- 更隐蔽的一半：**不清理旧目录**。进程 id 会被系统复用，于是新一次运行可能落进
  上一次失败留下的目录，里面还有上一轮的数据库——「刚建的任务列表里为什么有两个已完成任务」就是这么来的；
- 两种表现（数据串台、`database is locked`）指向同一个原因，只是撞上的时机不同。

### 2. 修法：新增 `core/tests/common/`，所有测试统一切过去
- `common::temp_dir(tag)`：**先 `remove_dir_all` 再 `create_dir_all`**，名称用
  「进程 id + 进程内原子自增」——不再依赖时钟精度，也保证每次运行都是空目录；
- 20 个测试文件全部改用它（9 个原本就有 `fn temp_dir` 的 + 11 个内联拼路径的），
  `mod common;` 由脚本统一插入；`core/tests/common/mod.rs` 自身不会被当成测试编译；
- 顺带把「下载列表只应有一个已完成任务」的断言改成带上完整列表，下次再出问题一眼能看出多了什么。

### 3. 验证：连续 12 次全量运行，零失败
修复前：约 1/6–1/10 失败（实测抓到四种不同的失败现场）。
修复后：`cargo test -p gently-core` **连续 12 次全绿**（每次 200 项）。

## 已完成（第二十五轮）

### 1. 冒烟新增「假宿主」能力（8 项断言）
- `withFakeCore(handler, body)`：临时把 `window.__TAURI_INTERNALS__` 换成假实现，
  **测的是我们自己的桥接与服务层**（不是另写一套假门面），结束后恢复现场；
- 覆盖到的桌面端分支：
  1. `coreAvailable()` 真的变 true；
  2. **核心优先读**：`libraryService.loadPlugins()` 拿到核心里那份（而不是 mock）；
  3. **核心报错如实呈现**（R18）：榜单树/榜单内容的 `error` 带着原始错误码交出来；
  4. **预期内失败保持安静**：核心报「未实现」时退回 mock 兜底、不往上抛错误；
  5. **皮肤裁决走完整路径**（R24）：核心标了 `active` 的皮肤会被采用为当前预设；
  6. 撤离假宿主后回到浏览器模式、门面重新返回 null（证明恢复是干净的）。

### 2. 顺手把这条约定写进 AGENTS
- 「加冒烟断言」的完成标准补了一条：能用纯函数断言的先抽纯函数；
  桌面端分支用 `withFakeCore()`，用完恢复现场——避免以后再出现「改了桌面端逻辑却只有人肉验证」。


## 已完成（第二十四轮）

### 1. 修掉「核心的 active 皮肤启动时不生效」
- `ui.loadSkins()` 此前只把核心返回的皮肤列表塞进 `customSkins`，**忽略了 `active` 标记**：
  换了机器或清过 localStorage 之后，核心明明记着用户选过某套皮肤，界面却回到默认预设；
- 现在按 `active` 纠正当前预设（`resolveActivePreset`），且**本地记的 id 必须仍然存在**
  （皮肤被删、换机器都会让它失效）才沿用，否则回默认。

### 2. 修掉「选内置预设时发一个核心不认识的 id」
- `setThemePreset` 原来把任意预设 id 都发给 `skin.setActive`，而核心的 `skins` 表里
  **只有用户皮肤**（内置预设随前端包发布）——选内置预设必然换来一条 `skin.not_found`；
- 现在只有**用户皮肤**才发 id，选内置预设发 `null`（= 清掉用户皮肤的激活标记，语义正好）。

### 3. 裁决逻辑只有一份，并且有测试
- 新增 `activeUserSkinId()` / `resolveActivePreset()`（`theme/presets.ts`）：规则是
  「核心标了 active → 用核心；否则沿用本地（内置预设只能这样记）；本地 id 失效 → 回默认」；
- 冒烟 +4 项直接测这套裁决（浏览器里跑不到核心分支，所以裁决必须是纯函数才测得动）；
- `ThemeProvider` 注明首屏用 localStorage（同步、不闪），随后按核心纠正。

> R25 又用**假宿主**把这条路径端到端补测了一遍：核心 `skin.list` 标了 `active` 的皮肤
> 确实会被采用为当前预设（见上）。

## 已完成（第二十三轮）

### 1. 核心：把插件的封面带出来
- `normalize_track` 新增统一字段 `artwork`：按 `artwork` / `cover` / `coverImg` / `pic` / `img` / `image`
  的顺序取**第一个非空值**（字段名在这个生态里不统一），认不出来就是空串；
- 曲目快照（收藏 / 历史 / 歌单）本来就存整份 JSON，因此封面**跟着快照一起留在了本机库**，
  插件卸载后收藏列表照样有图；
- 测试：MusicFree 风格源的 `artwork` 与 `coverImg` 都被认出来，缺封面时是空串（不是半个破图）。

### 2. 前端：一个优先级，六处渲染
- 新增 `trackCoverStyle(track)`（`utils/cover.ts`）：`artwork` 优先，其次 `gradient`，
  两者都没有时按「标题|歌手」哈希挑一个渐变——曲目封面在网格 / 榜单 / 播放条 / 歌词页 /
  相似推荐等处渲染，各写一遍优先级迟早会不一致；
- `Track` 类型补 `artwork?: string`；5 个调用点统一切到 `trackCoverStyle`；
- 浏览器预览保持渐变（mock 不内嵌任何第三方图片地址，ADR-0005）。

### 3. 如实记下的缺口
- **本地文件的内嵌封面没有提取**：把图片缩成数据 URI 会让每一行都背上几十上百 KB，
  而走文件缓存又要动媒体代理的白名单（当前只服务音频），代价与收益不成比例——写进 STATE 与 README，
  不假装已经支持。
  > **R37 已补**：改走「扫描时落进 `<data>/cache/covers/<hash>.<ext>` + 回环 `/cover/<name>` 路由」，
  > 列表只多一个短地址；顺带发现 mp3 的 ID3v2 只在**链式元数据**里（见 R37）。

## 已完成（第二十二轮）

### 1. 补上「专辑种子」这条契约路径的测试，照出两个真 bug
1. **参数被吃错**：`SeedParam` 是 serde 的 `untagged` 枚举，`Ref(Value)` 声明在前——
   而 `Value` 能吃下任何 JSON，于是 `{albumId}` 被当成曲目引用，最终报出
   「**ref 缺少 source 字段**」：一个与真实原因（种子类型没认出来）毫无关系的错。
   修法：`Album` 变体声明在前，并把字段名改成契约里的 `albumId`（原来写的是 `album_id`，
   与 camelCase 的 ABI 也对不上）；
2. **把专辑自己推回给自己**：专辑种子的排除集是空的，于是「这张专辑的所有曲目」
   都会以满分出现在相似推荐里。修法：排除**整张专辑**（与曲目种子「不把自己推给自己」同一规则），
   `rank_similar` 的 `seed_ref: &str` 随之改成 `exclude: &[String]`。

### 2. 相似推荐接到界面上（专辑/歌单详情页）
- 新增 `views/collection/components/SimilarList`（+ 样式）：刻意比主列表轻——不排名次、
  不显示专辑列，保留封面/曲目/歌手/**推荐理由**/时长；理由是这套算法的一部分，不能只给结果；
- 详情页在曲目表下方渲染这一块，**没有邻居就不渲染**（浏览器预览没有核心 → 空数组 → 不出现，
  不编一份 mock 打分）；
- 种子用**曲目种子**（`rows[0]`）而不是专辑 id：专辑种子要求快照里的 `albumId` 与源侧专辑 id 一致，
  而插件不保证提供这个字段——曲目种子是稳的。门面两种都支持（`SimilarSeed = Track | {albumId}`）；
- 顺带修掉一个类型小坑：service 的 `limit = appConfig.list.recommendLimit` 因为 `as const`
  被推断成字面量 `12`，显式标成 `number` 才能传别的值。

## 已完成（第二十一轮）

### 1. 搜索中止（用户动作 → 核心取消）
- `coreSearch(keyword, {signal})`：拿到 `searchId` 后立刻检查 `signal.aborted`（用户在等待期间
  就换了词），中止时 `catalog.searchCancel` 并**立刻收敛为 `null`**（不再挂到超时）；
  中止事件监听用 `{once: true}` 且在 `finish` 里移除，避免泄漏；
- `catalogService.searchAll(keyword, signal?)` 透传；搜索页在 effect 清理里
  `controller.abort()`——换关键词、切音源、离开页面三条路径都覆盖；
- 顺带让 `coreCancelSearch` 这个门面真正被用起来（此前只有超时分支直接 `invokeCore`）。

### 2. 核心侧把行为锁进测试与契约
- 新增测试 `cancelled_search_still_settles_with_a_done_event`：**取消不会让 `done` 不来**
  （前端的 await 由它兑现，否则界面会一直转到超时），并锁定「对已结束的搜索再取消返回
  `common.not_found`」——`not_found` 的语义（「搜索已结束或不存在」）是准确的，
  调用方按 fire-and-forget 处理，不值得为它加一套「已结束」状态；
- 契约 §2 的 `catalog.searchCancel` 行补上这两条行为说明。

### 3. 如实列清「有门面、没入口」的三处
`catalog.track`（曲目详情）、`catalog.recommend`（源侧推荐）、`recommend.similar`（相似推荐）
都有核心实现与前端门面，但**没有界面入口**——它们不是缺失实现，是我们**刻意没做**的界面。
这一点写进 STATE 而不是假装已接线（契约守卫要求「每条命令都有前端封装」，封装在，入口不在）。

## 已完成（第二十轮）

### 1. `core/tests/e2e_chain.rs`：M5 退出标准的自动化版本
一条测试串起七步，每一步都断言（不做「跑通就行」）：
1. **导入插件**：从磁盘上真实的 `examples/plugins/gently-demo.js` 导入（`consent: true`），
   校验来源记为 `file`、sha256 已记录，再 `plugin.reload` 建运行时并真实探测能力；
2. **搜索**：`catalog.search` 立刻返回 `searchId`，结果经 `catalog:search:partial`（逐源）
   与 `catalog:search:done`（收敛）事件到达——**与前端订阅的是同一套事件**，
   断言 3 首写死的曲目与来源字段；
3. **扫描**：临时目录里生成真 WAV（44 字节 RIFF 头 + PCM），`library.local.scan` 入库，
   `library.local.list` 查到，并且**扫描进度事件**`library:scan:progress` 确实推给了前端；
4. **播放解析**：`playback.resolve` 对本地曲目返回 `http://127.0.0.1:…/m/<token>`（回环代理）；
5. **真的播一次**：手写 HTTP 去打那个地址——
   整段响应 `200` 且字节与磁盘**完全一致**、`Content-Type: audio/wav`；
   `Range: bytes=0-43` 回 `206` + `Content-Range` 且只回 44 字节（WAV 头）；
   越界 Range 回 `416`（而不是 200 + 空体）。这条是「本地文件播放不需要 Blob hack」的证据；
6. **收藏 / 歌单 / 历史**：写入后从库读回，确认闭环落到了 SQLite（历史里 `playCount = 1`）；
7. **重启后仍在**：关掉 `CoreContext` 重新打开同一个库文件，收藏与插件仍在。

### 2. 它照出的真问题：`playback.resolve` 的参数名
- 契约与其它所有命令都写 `ref`，只有 `playback.resolve` 的实现是裸 `reference`：
  调用方按文档传 `ref` 会收到「**缺字段 `reference`**」——一个名字问题伪装成参数缺失；
- 修法：`#[serde(rename = "ref", alias = "reference")]`——**对外只有一个名字（`ref`）**，
  同时不弄坏历史写法；前端也改回契约名；契约 §2 补了一句参数名约定；
- 测试里两种写法都断言（别名不是摆设）。

## 已完成（第十九轮）

### 1. Windows Credential Manager（不经 `keyring` crate）
- `keyring` crate 不在离线 registry 缓存里，但**系统凭据 API 本身很窄**：
  `CredRead` / `CredWrite` / `CredDelete` / `CredEnumerate` 四个调用，
  于是直接用 `windows-sys`（**已在缓存**）调 Win32，比引一整套平台抽象更可控；
- 新增 `core/src/plugin/keyring.rs`：目标名 `gently:<plugin_id>:<key>`（凭据库是扁平的，
  前缀既能按插件隔离，又能用 `CredEnumerateW` 按插件枚举）；值以 UTF-16LE 存 blob；
  类型 `CRED_TYPE_GENERIC`、持久性 `CRED_PERSIST_LOCAL_MACHINE`；
- 失败**不 panic**：读失败当「没有」，写失败记 warn（用户看到的是 `credentials.status`
  里的「未配置」，而不是宿主崩掉）；值超过系统上限（5×512 字节）时明确拒绝写入；
- 非 Windows：`open()` 返回 `Err(说明)`，调用方退回内存实现（macOS/Linux 待补，契约写明）。

### 2. 降级路径与「如实上报」
- `CredentialStore` trait 新增 `backend()`（`memory` / `windows-credential-manager`）；
- `CoreContext::with_credentials()` 换存储（与 `with_http` 同因：宿主是单独构造的，必须重建）；
  **默认仍是内存**，因此单元/集成测试不会往用户的凭据库里写东西；
- `system.status` 新增 `credentialsBackend` 字段（契约 + TS 类型同步），
  设置页诊断卡片显示「已接入系统凭据库（重启后仍在）」或「降级为进程内存储」；
- 插件页的凭据提示也据此切换文案：接上了就说「存放在系统凭据管理器里，重启后仍然有效」，
  降级了才说「重启后需要重新填写」——**不再一律警告**。

### 3. 测试与实测证据
- `keyring.rs` 自带 2 项测试，**真的读写 Windows 凭据库**（用独立前缀 `gently-selftest`
  避免碰用户其它凭据，测完清理）：往返 + 覆盖写 + 按插件隔离 + 清除（含清除不存在的键）；
  超长值写入被拒且读回「没有」（不会留下半截值）；
- 打包版实测：日志出现 `凭据存储已就绪 backend="windows-credential-manager"`，
  即生产路径确实接上了系统凭据库（跨进程/重启的持久化由 `CRED_PERSIST_LOCAL_MACHINE` 保证）。

## 已完成（第十八轮）

### 1. 门面不再把错误伪装成「没有数据」
- `core.catalog.ts` 的详情包装新增 `onError` 回调：**预期内的失败**
  （`common.not_implemented` / `common.not_found`）依然安静（界面本来就有兜底），
  其它错误（插件抛错、上游失败、参数不合法）除了打 `console.warn`，还会把 `CoreError`
  交给调用方；
- `catalogService.fetchTopLists` / `fetchTopList` 返回 `{groups|page, error?}`：
  **核心报错时不再退回 mock**——那会把「源跑挂了」伪装成「这个源没有分类」，
  把用户引到完全错误的方向；
- 榜单切片新增 `error: CoreError | null`：存结构化错误（不存文案），
  由视图经 `errorText()` 取本地化文案，错误码 → 文案仍然只有一份映射。

### 2. 界面如实说明
- 分类树拿不到 + 有错误 → 「这个音源出错了」+ 本地化原因；
  没有错误才显示「该音源没有提供榜单」（两种空态语义不同）；
- 分类树拿到了但这一页取不回来（如上游 404）→ 列表下方一行红色说明；
- 新增 i18n `page.ranking.sourceErrorTitle`（zh/en），新增 `views/ranking/ranking.module.css`
  的 `.errorHint`（用 token，不硬编码）。

### 3. 测试
- 冒烟把两条门面断言改成新形状，并新增「浏览器下分类树**不带错误**」一项
  （保证 mock 兜底没被这次改动弄丢）：216 → **217**。

## 已完成（第十七轮）

### 1. 便携版分发产物（离线可用）
- 新增 `scripts/package-portable.mjs` + `pnpm package:portable`：把 release 二进制、
  README 与一份**面向用户的便携说明**（数据目录在哪、怎么彻底卸载、已知限制）打成
  `release/gently-0.1.0-windows-x64.zip`，并附 `.sha256`；
- 为什么需要它：Tauri 的 MSI/NSIS **首次必须联网**下载 WiX/NSIS 工具链，本机拿不到网络
  （实测 `Invoke-WebRequest` 与 Tauri CLI 双双超时）。而 `gently.exe` 已经把前端资源编进二进制
  （`frontendDist`），所以「exe + 说明」就是完整的便携版——**能交付，且不假装有安装包**；
- `release/` 加进 `.gitignore`（打包产物不入库）。

### 2. README 从模板换成真文档
原来还是 Tauri 模板的 4 行占位。现在写清：定位（无服务器 / 中立立场 / 插件双轨制）、
目录结构、快速开始（浏览器预览 vs 桌面端）、命令表、**离线构建约定**、出包两种方式、
文档导航，以及**如实列出的已知缺口**（内存凭据、无文件选择器、安装包需联网、视觉待走查）。

### 3. 日志落盘（M5 的「日志按天滚动、保留 7 天」）
- 之前 `logging.rs` 只打控制台，设置页的「打开日志目录」永远指着一个空目录——**文档写了、实现没做**；
- 现在用 `tracing-appender` 按天滚动写到 `<data>/logs/gently.log.<日期>`，启动时清理 7 天前的文件
  （日期解析自带单测：闰年 / 非法日期都覆盖），拿不到目录就只打控制台、不拦启动；
- `WorkerGuard` 挂进 `AppState`（否则日志会停在启动那一刻），打包版实测已能看到日志文件。

### 4. 失败要留下痕迹（两个真实缺口靠它现形）
- `dispatch` 失败时不再只记 `ok=false`，而是连**错误码与说明**一起记（`WARN` 级别）；
- 前端 `detail()` 包装对「预期内的失败」（`not_implemented` / `not_found`）保持安静，
  其它错误打 `console.warn`——之前界面只显示空列表，日志也只有一行 `ok=false`，谁也判断不出原因；
- 打开日志后立刻看到两件事，并当场修掉：
  1. **`require('x').default` 是 undefined**：转译插件普遍写 `axios_1.default.get(...)`
     （TS `esModuleInterop` 产物）。MusicFree 的做法是 `pkg.default = pkg`，我们照抄
     （对象**与函数**都要处理，axios 垫片本身可调用）。修之前报错是
     「cannot read property 'get' of undefined」，与真实原因完全看不出关系；
  2. **MusicFree 的三个函数名没有映射**：`getMusicInfo` / `getMusicSheetInfo` / `getTopListDetail`
     分别对应我们的 `getTrackInfo` / `getPlaylistInfo` / `getTopList`。兼容插件不会改名字，
     因此在能力收集处统一解析别名（自有 ABI 名优先，`getRecommend` 没有对等物**不映射**）。
- 实测证据（打包版 + 用户自己装的真实兼容插件）：修改前 `catalog.topLists` 与 `catalog.topList`
  都因为上述两个原因失败；修改后 `catalog.topLists ok=true`，`catalog.topList` 变成
  `plugin.runtime_error / Request failed with status code 404`——**失败原因如实暴露**，而不是静默空列表。

## 已完成（第十六轮）

### 1. 变量声明 → 凭据字段（清单侧）
- `probe` 现在也读 `module.exports.userVariables`（MusicFree 的变量声明数组），
  只保留有 `key` 的条目（MusicFree 自己也这么过滤），`label` 缺失退回 `key`；
- `compat.rs` 合成清单时把它们放进 `credentials`，并**自动补上 `credentials` 权限**——
  声明了变量却读不到值等于没声明；
- 预览警告里明说「插件声明了 N 个用户变量（…）：需要在插件页填写后才能真正使用」，
  于是既有的凭据面板**不需要改一行**就能承载这些字段。

### 2. 沙箱 `env`（运行侧）
- 新增宿主函数 `__hostUserVariables()`：只回**清单声明过**的键，且只在有 `credentials`
  权限时回值（与 `credentials.get` 同一道门）；没有再走一遍 `credentials` 的读值逻辑；
- bootstrap 包成 `env.getUserVariables()` 与 `env.userVariables`（两者读同一份数据，
  **空时返回 `{}` 而不是 `undefined`**——插件常写 `const {cookie} = env.getUserVariables()`，
  返回 undefined 会直接抛错）；
- 同时补 `env.os` / `env.appVersion` / `env.lang` 与 `process{platform, version, env}`
  （MusicFree 把这些一起传进插件，有的插件读 `process.env`）；
  `env.os` **如实报告当前桌面平台**，不假装成 `android`——插件若因此拒绝运行，用户看到的才是真原因；
- 新增的原始宿主入口照旧在 bootstrap 末尾删除，插件只能用受控封装。

### 3. 测试
- `core/tests/host.rs` +2：`env.getUserVariables()` 读到用户填的值（含 `env.userVariables`
  与它同源、`process.env` 指向同一个 env、原始入口已删除）、**没有 `credentials` 权限时读不到值**；
- `core/tests/compat_import.rs` +1：`userVariables` 声明转成凭据字段（含「没有 key 的条目被忽略」、
  自动补 `credentials` 权限、警告里有「用户变量」字样）。

## 已完成（第十五轮）

### 1. 压缩包导入（核心）
- 新增 `core/src/plugin/archive.rs`：`zip` 只开 **deflate** 后端（离线 registry 里只有它，
  也确实不需要 zstd/bzip2/aes）；解压到目标目录后**归一化**成两种既有形态——
  根下有 `plugin.json` → 目录包；根下恰好一个 `.js` → 单文件（统一改名成 `plugin.js`，
  并丢掉 README 之类附件）。**包内多套一层目录会被拍平**（常见的 `my-plugin/...` 打包方式）；
- 因此安装路径没有分叉：`InstallSource::Archive` 只是「取得一个插件目录」的第四种途径，
  与 `Dir` / `File` 共用同一套校验与落盘逻辑（顺带把目录包的解析抽成 `stage_dir_package` /
  `parse_dir_package`，预览与安装共用一份）；
- **防解压攻击**（压缩包是唯一需要防的来源）：条目数 ≤ 512、解压后总大小 ≤ 8 MiB
  （与插件体积上限一致）、只用 `enclosed_name()` 给出的相对路径（`..` / 绝对路径直接拒绝）、
  拒绝符号链接（否则包外文件会被拖进来）；不满足时 `plugin.invalid_source` 并说明原因
  （多个 `.js` 会把候选列在 `details.candidates` 里）；
- 预览路径解压到**系统临时目录**（用完即删），不污染插件目录；失败路径新增
  `discard_staging()`，连空的 `.staging` 父目录也一并清掉。

### 2. 前端：「本机路径」来源
- 插件页导入面板新增第三种来源（压缩包 / 单文件 / 目录包三选一 + 路径输入）；
- **不提供「浏览…」按钮**：原生文件选择器需要 `tauri-plugin-dialog`，而它不在离线依赖缓存里——
  界面说明这一点并让用户粘贴路径，而不是放一个点了没用的按钮。

### 3. 测试与文档
- 新增 `core/tests/plugin_archive.rs`（5 项）：单文件包安装成 `plugin.js`、目录包 + 拍平、
  **zip-slip 被拒且不写出目录外**、**zip bomb 被拒且不留暂存**、多入口/空包给出可执行错误；
- 旧的 `unimplemented_sources_say_so_explicitly` 改成 `every_import_source_kind_is_implemented`
  （四种本地来源全实现，缺失路径也要给带 `details.path` 的具体错误，而不是含糊的 not_implemented）；
- 契约 §2「导入来源」补上压缩包的限制（条目数/体积/穿越/链接/形态唯一）。

## 已完成（第十四轮）

### 1. 一个页面覆盖两类对象
- 新增路由 `/collection/:kind/:source/:id`（`kind ∈ album | curated`）与 `views/collection`：
  两类对象都是「一组曲目 + 一点元数据」（专辑有年份/歌手，歌单有描述/标签），
  分成两个几乎一样的页面只会让以后每次改动都要改两遍；
- `catalogService.fetchAlbum` / `fetchCuratedPlaylist`：桌面端走核心（插件 `getAlbumInfo` /
  `getPlaylistInfo`），浏览器退回 mock 的 `findAlbum` / `findCuratedPlaylist`，
  **两条路径返回同一形状**（含 `tracks`），视图不分支；
- 页面内容：头图 + 类别 + 标签 + 年份/描述 + 曲目表（复用 `table.config` 的列）+
  「播放全部」与「返回」；轨道行点击沿用 `usePlayRow`（与其他列表一致，点当前曲目=暂停）；
- 详情数据是**视图内的一次性请求**（按路由参数拉一次），不进 store——它不被其它视图消费；
- 推荐页 `AlbumGrid` / `PlaylistGrid`：**点卡片进详情**（完整曲目在详情页），
  封面上的播放键仍然「立即播这一张」。

### 2. 封面渲染收口（顺带修掉的真 bug）
- 三种来源的封面形状不同：核心（真实源）给**图片地址**、mock 给**渐变色**、
  核心对推荐结果返回**空串**；而前端此前一律 `style={{background: cover}}`——
  桌面端于是拿到 `background: ''`（透明块），图片地址也会被当成渐变解析失败；
- 新增 `src/utils/cover.ts` 的 `coverStyle(cover, seed)`（唯一一份）：
  `http(s)`/`data:` → `background-image`；其它非空值 → `background` 透传（渐变）；
  空值 → 按 `seed` 稳定哈希挑一个渐变兜底；
- 应用点：`AlbumGrid` / `PlaylistGrid` / `TrackGrid` / 榜单 `ChartList` /
  播放条封面 / 歌词页封面（6 处），主题新增 `components.collection.coverSize` token 供详情头图使用。

## 已完成（第十三轮）

### 1. 排行榜：从「日期榜单」改成「源的分类树」
- **删掉的都是没有数据支撑的部分**：`ChartSection` / `DatePicker` / `HeroCard` 三个组件、
  `utils/chart.ts`、`ChartType` / `Period` / `DateSelection` / `WeekOption` / `SongRow` 类型、
  「热度」列与 `rankedTracks` 拼装（真实源不返回热度，编一个只会误导）、
  榜单切片里的 `period/date/weekStart/chart/query/expanded` 条件（`query` 更是从来没有输入入口）；
- **新的数据流**：`catalog.topLists{source}` → 分类树（`{title, items}`，结构由源决定）→
  默认选中第一个分类 → `catalog.topList{source, id, page}` 取一页 → 「加载更多」按
  `nextPage` 翻页（源说 `hasMore` 才给入口，缺字段不猜）；
- **新组件**：`TopListNav`（组名 + 条目 chips，选中即切换分类）与改造后的 `ChartList`
  （名次 / 封面 / 曲目 / 专辑 / 时长，名次就是**源给的顺序**，核心不重排）；
- 主题 token 同步改名：`components.chart` → `components.topList`（去掉 heat 两项），
  CSS 变量 `--chart-*` → `--top-list-*`（全仓搜索旧名后替换，冒烟守卫保证没有失效变量）；
- i18n 清掉 `page.ranking` 下 20 个失效键（chart/period/thisWeek/hero/heat/…），
  换成「该音源没有提供榜单」「加载更多」等 5 个真实需要的键（死键守卫会挡住漏删）。

### 2. 统一音源清单（顺带修掉的一个真 bug）
- 之前有两份音源清单：mock 注册表（`catalogService.listActiveSources()`）与 store 的插件列表
  （桌面端来自核心 `plugin.list`）。桌面端两者**交集恒为空**——结果是 `SourceFilter` 直接不显示、
  设置页「优先音源」为空、榜单默认源永远落到 mock。现在一律以 **store 的插件列表**为准：
  `SourceFilter`、设置页都改成读它，`ranking.load()` 先 `plugin.load()` 再从已启用插件里挑源；
- 浏览器预览不受影响（那份列表本来就是内置模拟源）。

## 已完成（第十二轮）

### 1. 凭据 + 配置面板（`plugin-settings.tsx`）
- 挂在已安装插件行的「凭据与配置」按钮下（不引入路由/弹窗层），数据来自
  `plugin.credentials.status` / `plugin.config.get`；
- **凭据**：按清单声明过的键逐项填写（`secret` 用密码框），只提交**用户填过的**键；
  保存后立刻清空草稿——值**回显不了**（命令层没有读值出口），留着输入框只会误导；
  支持单项清除与「清空全部凭据」；把「**当前是内存实现 → 重启失效**」写在面板里（契约 §2 的已知缺口）；
- **配置**：JSON 文本编辑（未知字段原样保留），保存带 `revision`；`common.conflict` 时提示
  「已在别处改动，请先重新载入」而不是让用户反复点保存。

### 2. 订阅源面板（`subscription-panel.tsx`）
- 订阅列表（名称 / 条目数 / 上次刷新时间 / 最近失败原因）、添加（URL + 可选名称）、刷新索引、移除（二次确认）；
- **订阅内的条目列表**：名称/版本/作者/来源订阅 + 「已安装」/「有更新」标记；
- **一键安装仍走「预览 → 显式同意 → 安装」**：订阅省掉的只是「找文件」这一步，不是省掉同意
  （社区插件是不可信代码，AGENTS 约束 14）——权限与凭据需求照样先摆出来，勾选后才 `plugin.import`，
  安装后自动 `plugin.reload` 建立运行时；
- **中立立场**：不预置任何订阅地址、不出现「官方/推荐」措辞，地址必须用户自己粘贴（ADR-0005）；
- 权限措辞抽到 `views/plugin/permissions.ts`，导入面板与订阅面板共用一份。

### 3. 覆盖
- 冒烟新增 `PluginSettings` 渲染断言（浏览器模式：门面全返回空时面板必须照常渲染）；
- `core.plugin.ts` 里 R10 留下的「服务层已就绪、缺 UI」的 11 个命令封装至此**全部有界面消费**。

## 已完成（第十一轮）

### 1. 错误码 → zh/en 文案（26/26）
- `src/i18n/locales/{zh,en}.json` 新增 `errors` 命名空间，**26 个错误码全覆盖**；
  `src/i18n/errors.ts` 提供 `errorKey(code)`（点号换下划线，避免 i18next 的 keySeparator 误判）与
  `errorText(t, error)`（查不到就退回核心 message，不显示键名）；
- 用它替换了这些会暴露核心错误的界面：插件导入面板（6 处）、设置页诊断卡片、
  皮肤导入（按码给文案，被拒键名仍单独列出）；
- 新增冒烟断言「每个错误码都有 zh/en 文案」——加错误码却忘翻译会直接失败；
  `errors.` 加入 i18n 死键检查的动态前缀白名单。
- 顺带修掉 `CoreEventMap` 与实际事件载荷不一致的 3 处：下载事件是
  `{id, received, total?, speed?}` / `{id, path, bytes}` / `{id, code, message}`，
  **不是**整个 `DownloadTask`（契约 §3 表格本来就是这么写的）；下载失败原因因此能按
  `code` 本地化，并在下载页曲目名下方显示（新增 `DownloadTask.errorCode`）。

### 2. `pnpm verify`（M5 退出标准之一）
- 新增 `scripts/verify.mjs`：依次跑 `typecheck` → `smoke` → `check:contract` → `cargo test -p gently-core`，
  任一步失败即停并汇总；离线环境默认给 cargo 加 `--offline`
  （`GENTLY_CARGO_ONLINE=1 pnpm verify` 可切联网）。AGENTS 的命令表同步更新。

### 3. 诊断卡片补全
- 数据目录与**日志目录**分成两行各自显示路径 + 一键打开（排障时不用先找数据目录再猜日志在哪）。

### 4. 删掉 `<audio>` 的 Blob／`audio/mp4` hack（M3 退出标准最后一项）
- 前端 `audio.service.ts` 不再在 `.m4s` 时抓成 Blob 强制类型，`load()` 回归同步；
- 改由**回环流代理**决定 `Content-Type`：上游给 `application/octet-stream` 或干脆不给时，
  按地址扩展名补一个音频类型（`.m4s` → `audio/mp4`），上游给出具体类型时一律照抄
  （`effective_content_type`，4 项单测覆盖：照抄 / 猜测 / 不猜未知扩展名 / 扩展名映射）。
  这件事只能在代理层做一次，前端不再需要任何 hack。

### 5. 歌词接上 `catalog.lyrics`
- 新增 `src/utils/lyrics.ts`（**唯一一份**歌词解析）：支持核心已解析的 `lines`、带时间轴的 LRC、
  没有时间轴的纯文本（按占位节奏给行时间，明确标注不是真实时序），
  并把 `translated` 按**同一时间戳**对齐到行上（对不上的行不硬凑）；
- `library.service.loadLyrics` 改为：桌面端**以核心为准**（没歌词就是空，不拿生成的假歌词糊弄），
  浏览器预览才用 mock 生成；`LyricLine` 增加可选 `translation`，歌词组件在原文下方弱化显示译文。

## 已完成（第十轮）

### 1. 推荐（去掉第二份实现）
- 新增 `coreRecommendHome(limit)` / `coreRecommendSimilar(seed, limit)`（`recommend.home` / `recommend.similar`），
  `recommend.service.ts` 改为**桌面端读核心、浏览器用预置数据**（新增 `src/mock/recommend.mock.ts`）；
- **删除 `src/utils/recommend.ts`**（前端打分算法整体消失）——这是 AGENTS 第 15 条「同一算法只允许一份实现」
  的兑现：画像/权重/理由逻辑此后只在 `core/src/recommend.rs`。`topTags`（仅排序取前 N，不是算法）
  移到 `src/utils/taste.ts`，`src/mock/recommend.mock.ts` 的理由对象改用契约里的 `RecommendationReason` 类型
  （此前 `kind: string` 与 `RecommendationKind` 不兼容）。

### 2. 播放历史上报（`playback.report`）
- `core.library.ts` 新增 `corePlaybackReport(track, {source, quality, playedSec, completed})`；
- **时机**：一首歌放完 / 被切走 / 暂停 / 停止时各报一次（同一个 `playId` 只报一次），
  因此历史里记的是**真实播放秒数**与**实际播成的音源**（候选回退后可能与引用的来源不同）——
  这正是 `playback.report` 比 `library.history.push` 多出来的信息；
- 相应地 `library.slice.recordPlay` 只做**乐观 UI**（不再写核心），避免同一首歌的播放次数被记两次；
  `library.history.push` 仍是契约原语（前端封装保留，供核心复用同一实现）。

### 3. 插件管理接线
- 新增 `src/services/core.plugin.ts`（`plugin.checkUpdate` / `config.get|put` / `credentials.set|clear|status` /
  `subscriptions.list|add|remove|refresh` / `catalog.list`）——读失败返回 `null`，写返回 `CoreResult`，
  让界面能处理 `common.conflict`（配置并发）与 `common.invalid_argument`（凭据键未声明）；
- `library.service.ts` 的 `loadPlugins()` 改为**核心优先**；新增 `checkPluginUpdate` / `setPluginEnabled` /
  `setPluginPriority` / `removePlugin`；
- 插件切片：启停/卸载/检查更新在桌面端落核心，浏览器预览退回原 mock 行为（检查更新无来源可比 →
  沿用「补丁位 +1」的演示行为）；`update(id)` 因此变成异步（smoke 断言改为 await）。

### 4. 皮肤市场接线
- 新增 `src/services/core.skin.ts`（`skin.list|preview|install|remove|setActive|export`）与
  `skin.service.ts` 门面：桌面端导入走 `skin.preview`（校验 + 警告）→ `skin.install`（落盘），
  失败时把**被拒的令牌键名**（`details.rejected`）原样带出（新增 i18n `skin.importRejected`）；
- ui 切片新增 `loadSkins()`（桌面端皮肤以核心为准）、`setThemePreset` 同步 `skin.setActive`、
  `removeSkin` 同步 `skin.remove`；`ThemeProvider.exportSkin` 改为异步（核心返回落盘原文，浏览器序列化兜底）；
- 浏览器预览仍用 `src/theme/presets.ts` 的本地解析，但两条路径**返回同一形状**，视图不分支。

### 5. 契约守卫加严（双向）
- `scripts/check-commands.mjs` 不再只看 `core.bridge.ts`：改为扫描 `src/services/**` 的**全部命令名字面量**
  （很多命令经统一包装函数转发，名字是普通字符串参数），再减去事件名与错误码；
- 新增**反向检查**：契约里的 60 条命令**必须都有前端封装**，否则失败——「后端有、前端没接线」
  从此会被 CI 挡住（正是本轮之前的状态：18 条命令没有封装）。
- 同步修正 `src/api/index.ts` 与 Rust 实际返回不一致的三处：`PluginCredentialStatus` 补 `label`/`secret`、
  `checkUpdate` 补 `changed`/`source`（新增 `PluginUpdateCheck`）、`Subscription.updatedAt` 从 `string` 改为
  毫秒时间戳、`plugin.reload` 返回 `PluginSummary`。

## 已完成（第八轮、第九轮）

### 1. 定位与决策
- 三条约束：**不提供服务器**（无账号、无市场后端、无遥测）；将来同步歌单是**用户自己的第三方账号**
  （凭据存本机 keyring，不经我方服务）；**桌面端无 web 端**。
- 新增 `docs/adr/0003-no-server-local-core.md`：取消 HTTP 服务形态，改为「Rust 本机核心 + Tauri IPC」。
  ADR-0001 整体作废；ADR-0002 保留语言选择（Rust），传输层由 axum/HTTP 修订为命令/事件 + specta 绑定。
- 分发机制定为**通用导入**（本地目录 / 压缩包 / URL / 粘贴文本四合一 `ImportSource`）：
  社区仓库由用户自行 clone 后指向目录，**应用不内建 git 客户端**（不要求用户装 git）。

### 2. 契约重写（`docs/contracts/local-core-api.md` + `src/api/index.ts`）
- **约 45 条命令**（v0.1 口径，v0.2 修订见本节第 4 小节）
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

### 4. 契约 v0.2 修订（对照主流源数据软件）

对照 **Legado 的 Tauri 社区书源仓库规范**（`repository.json` + 单文件书源 + cli-testing）与
**MusicFree 插件协议**（单文件 + 头部注释元数据 + 顶层函数）做了评估，结论是 v0.1 有三处硬伤，
据此把契约修订到 **v0.2**（`docs/contracts/local-core-api.md`，`src/api/index.ts` 同步）：

- **插件 ABI 补齐**：4 → **9 个函数**（`search` / `getMediaSource` 必选，其余 7 个可选）。
  v0.1 的 ABI 支撑不了 `catalog.album` / `playlist` / `lyrics` 等命令，那些命令本会永远无法实现；
  函数缺失时对应命令返回 `common.not_implemented` 并隐藏 UI 入口。
- **媒体传输**：新增**本地流代理**。WebView 的 `<audio>` 不能设 `Referer` / `UA` / `Cookie`，
  且需要 Range；`playback.resolve` 改为返回 `ResolvedMedia`（`streamUrl` 指向仅回环的一次性 token 代理，
  `originUrl` / `headers` 只用于排障），代理做头部注入、Range/206 透传、`no-store`，
  并阻断内网/回环/链路本地地址（`media.blocked_address`）；本地文件同通道。
- **订阅分发**：新增 `repository.json` 订阅索引（与 Legado 社区仓库规范同构、字段只增不改）
  + `plugin.subscriptions.*` / `plugin.catalog.list` + `ImportSource{kind:'catalog'}` 一键安装；
  插件主形态改为**单文件 `.js` + 头部注释元数据**，目录包降为高级形态；分发仍不依赖我方服务器。
- **流式搜索**：`catalog.search` 立即返回 `{searchId}`，结果经 `catalog:search:partial` 逐源到达，
  `catalog:search:done` 给跨源合并结果，新增 `catalog.searchCancel`——一个慢源不再拖死整页，
  合并仍在核心完成；`catalog.charts` 由 `catalog.topLists` / `catalog.topList` 取代
  （真实源是任意分类树，排行榜页待改为按源渲染）。

规模：**约 57 条命令 + 8 类事件**；新增错误码 `plugin.invalid_source` / `subscription.fetch_failed` /
`subscription.invalid_index` / `media.proxy_failed` / `media.blocked_address`。并明确
**前端 `src/plugins/**` 不是插件 ABI**（只是 mock 兜底的最小接口）。

### 5. M1a：插件清单与 preview（第十一轮，已完成）

- **清单解析**（`core/src/plugin/manifest.rs`）：单文件头部注释（前 60 行 `// @key value`）与
  目录包 `plugin.json` 统一为 `PluginManifest`；校验 id/version 形状、音质、权限、域名白名单、
  凭据字段；**权限推导**（声明 `@hosts` / `@credentials` 即自动具备对应权限，避免作者漏写导致
  能力静默失效）；未知头部字段只警告；错误带字段级 `details`。
- **能力静态预扫描** + 必选函数（`search` / `getMediaSource`）缺失警告；
  M1b 接入运行时后由真实探测覆盖，预扫描仅用于预览提示、**不作安全判断**。
- **`plugin.preview` 真实实现**（已实现命令 3 → 4）：`paste` / `file` / `dir` 三种来源，
  产出 `{manifest, permissions, credentials, warnings, replacesExisting}`；
  `archive` / `url` / `catalog` 返回 `not_implemented` 并说明「哪个来源 + 已支持哪些」；
  **只读不写**（测试断言 preview 后插件目录仍为空）。
- **中立性落地**（ADR-0005）：不内置任何第三方入口；清理了模拟源里两个伪造的第三方 homepage，
  模拟源改名并标注「不访问网络」；`plugin.subscriptions.*` 保留但无默认值。

### 6. M1a-2：安装与状态（第十二轮，已完成）

- **迁移 0002**：`plugin_state`（清单整体存 JSON + 可查询列 enabled/priority/origin/sha256）
  与 `plugin_config`（乐观并发 revision）。文件在磁盘、状态在库。
- **`plugin.import`**：同意是硬门槛（`consent` 必须为字面量 `true`）；落盘走
  **暂存 → 从暂存副本重新校验 → 原子 rename**；覆盖安装先把旧版本移到 `.trash`，
  失败则把旧版本放回；单文件归一化为 `plugins/<id>/plugin.js`，目录包整体复制
  （跳过符号链接、累计 8 MiB 上限）；入口 sha256 入库；完成后清理空目录。
- **`plugin.list` / `remove` / `setEnabled` / `setPriority`**（已实现命令 4 → 9）；数据库不可用时
  明确失败（`library.io_error` + 原因），不假装装上。
- 测试抓到的真 bug：`RemoveParams` 漏 `rename_all = "camelCase"`，前端 `deleteFiles: false`
  被静默忽略导致误删文件——已修并加了对应断言。

### 7. M1b：插件运行时与沙箱（第十三轮，已完成）

- **专用线程 + 同步执行模型**：每插件一个线程持有自己的 QuickJS；宿主 `fetch` 阻塞，
  插件写 `async function` 也能用（宿主手动排空微任务队列，不需 async 运行时）。
- **沙箱**：只有 bootstrap 显式安装的 `fetch` / `console` / `storage` / `credentials.get`；
  `fetch` 仅 HTTPS 且限 `@hosts`；bootstrap 后删除全部 `__host*` 入口（有测试断言）。
- **限制**：内存 64 MiB、栈 1 MiB、单次调用 8s（中断处理器，死循环被及时掐断）、
  响应 4 MiB 上限、重定向每跳重新过白名单。
- **能力探测**：运行时识别 `function` / `const =>` / `globalThis.x =` 三种写法并写回清单
  （安装期静态扫描认不出箭头函数）；新增 `plugin.reload`（已实现命令 10 条）。
- OS keyring 仍为内存实现（`keyring` crate 未缓存），M1c 接入。

### 8. M1c：订阅与社区仓库（第十四轮，核心已完成）

- 迁移 0003 `subscriptions`；索引缓存在 `<data>/subscriptions/<id>.json`（断网可列出条目）；
  订阅 id 由 URL 的 sha256 派生。
- **索引按不可信输入处理**：`fileName` 拒绝路径穿越、`downloadUrl` 必须 HTTPS 且非内网（防 SSRF）、
  `sha256` 格式校验；非法条目整份拒绝并把字段级细节写进 `lastError`。
- 命令 `plugin.subscriptions.list/add/remove/refresh` + `plugin.catalog.list`（已实现 15 条）；
  `{kind:'catalog'}` 接入预览（下载不落盘）与安装（sha256 校验后才落盘，来源记为 catalog）；
  刷新失败保留旧索引并报 `subscription.fetch_failed`。
- **作者 CLI 与示例插件已完成**：`plugin-tool check/index`（逻辑在 `plugin::authoring`，可测）+ `examples/plugins/`（示例不联网、不解析真实音源，有测试保证其合法）。`@url` 被误当未知字段的 bug 由 CLI 实跑发现并修复。
- **URL 导入与导入界面已完成**：`{kind:'url'}` 走核心下载（仅 HTTPS/非内网），插件页新增「本机核心插件」面板（粘贴/地址 → 预览权限与凭据 → 显式同意 → 安装 + 已安装列表 + 第三方免责声明）；浏览器下只提示需桌面端。`archive` 与原生文件选择器在 R15 与后续轮次补齐。
- **管理动作已接入界面**：启停/重载/上移下移（整表重排回写优先级）/卸载（二次确认）；安装后自动 reload。
- ✅ **重启缺口已解决**：M2a 起搜索前会 `ensure_loaded` 按需加载已启用插件（单个失败只跳过），用户不必手动重载。
- **插件格式双轨制**（`docs/adr/0006-plugin-format-dual-track.md`）：自有 ABI 为默认；兼容模式默认关闭，允许任意公网 HTTPS（本机/内网始终拒绝）。已完成 CommonJS 环境、`module.exports` 探测、`@compat` + 域名策略、缺依赖可执行报错。
- **`require` 垫片已完成**（ADR-0006 待完成第 1 项）：沙箱 JS 拆到 `core/src/plugin/sandbox/`（bootstrap + compat，`include_str!` 编进二进制），固定清单 `he` / `axios`（→ 宿主 `fetch`，含 `params`/`headers`/`data`/`validateStatus`/请求与响应拦截器）/ `dayjs`（解析·format·加减·startOf/endOf·diff）/ `crypto-js`（MD5 + SHA256 + WordArray + Hex/Base64/Utf8/Latin1）。摘要由宿主算（新增与 sha2 同族的 `md-5` 依赖），垫片只做形状翻译——白名单、兼容模式域名策略与「不打本机」在垫片下一律照旧（有测试锁定）。清单外模块与子集外算法都抛可执行错误。
- **返回形状适配已完成**（第 2 项）：`plugin::shape::list_items` 统一拆包裹（裸数组 / `{items}` / `{isEnd?, data}` / `{isEnd?, musicList}`，依据 MusicFree 插件协议），未在协议里出现的键名不猜、形状不认识就丢弃并计数；条目字段同步放宽——MusicFree 的 `duration` 是**数字秒**，与自有 ABI 的 `durationSec` / `"3:05"` 并存（`isEnd` 暂不参与分页，M2 搜索只取第一页）。
- **流程接线已完成**（第 3 项）：`plugin.preview` / `plugin.import` 增加 `compat` 参数（与头部 `@compat` 并存，两侧口径一致），头部元数据不全时由 `plugin::compat` 用 `probe` 在**无出网通道**的沙箱里只读执行一次，从 `module.exports` 合成清单（`id = compat-<sha256(platform) 前 8 位>`，升级不换 id；版本/作者/音质都有降级与警告；能力以运行时探测为准）。预览与 `PluginSummary` 都带 `compat`，导入面板增加兼容开关、预览时的权限弱化提示（网络权限文案也随之改写）与已安装列表的「兼容」标记（zh+en）。顺带补上 `probe` 的**截止时间中断**——探测会执行插件顶层代码，死循环必须被掐断而不是卡死预览。
- **TOFU 收敛已完成**（第 4 项，ADR-0006 待完成清单至此清空）：沙箱**放行**兼容请求时把域名记进观测台账（`plugin::hosts`，内存 + `plugins/.hosts/<id>.json`；只在出现新域名时落盘、卸载即清、探测期不记）；新增命令 `plugin.compat.observed` / `plugin.compat.confirm`（契约 **59 条命令**、已实现 20 条）——后者把观测到的域名固化成 `hosts` 白名单并**关闭兼容模式**（兼容分支先于白名单，不关就等于没写），白名单只能来自观测结果且必须 `consent: true`（否则这个命令就是提权入口），收敛后卸载运行时、下次使用按新清单重新加载。界面在已安装列表给出「收敛权限」入口（二次确认里列出将要固化的域名）。
- **详情类命令已完成（M2b）**：`core/src/catalog_detail.rs` 实现 `catalog.track` / `album` / `playlist` / `topLists` / `topList` / `recommend` / `lyrics`（已实现命令 20 → **27**，契约仍是 59 条）：复用搜索的归一化与形状适配（`albumItem` / `sheetItem` / `musicList` / `rawLrc` 都能进）；能力缺失 → `common.not_implemented`（UI 隐藏入口）、未安装/已禁用 → `common.not_found`、引用格式错误 → `common.invalid_argument`；`catalog.track` 的 `id` 回到请求的 `ref` 并包成 `GroupedTrack` 供视图复用；`catalog.topList` 由 `isEnd` 推导 `hasMore`/`nextPage`；结果缓存到 `cache/catalog/`（详情 6h、榜单 24h、原子写、键带齐页号与翻译开关，读坏即回退插件）；歌词不在核心解析成行（前端已有解析器，算法只留一份）。前端门面同步补齐（`core.catalog.ts` 的 7 个函数 + 冒烟断言：无宿主时一律 null）。
- **本机库持久化已完成（M3a）**：迁移 **0004** 建 `favorites` / `playlists` / `playlist_tracks` / `play_history`；`core/src/store/library.rs`（读写 + 复合游标分页）与 `core/src/library.rs`（命令层，已实现命令 27 → **34**）落地 `library.favorites.list/set`、`library.playlists.list/save/delete`、`library.history.list/push`。要点：**曲目快照存库**（插件被卸载/改接口也能列出歌单），快照由调用方 `track` 参数带来、缺了退化成占位曲目（核心不为了补标题去调插件）；引用 `source:trackId` 去重、参数接受字符串或 `TrackRef` 对象；历史每次播放留一行并给累计次数；歌单整体覆盖（顺序 = 传入顺序、重复引用只留一次）、删除级联；`(时间戳, 主键)` 复合游标 + `total`，`limit` 1~500；库不可用 → `library.io_error`（不假装成功）。测试覆盖「重启后数据仍在」。
- **本地曲库已完成（M3b）**：迁移 **0005** 建 `local_tracks` + **FTS5**（trigram 词元化 → 中文子串可搜，1~2 字退回 LIKE），`core/src/store/local.rs` + `core/src/local_library.rs` 落地 `library.local.scan/list/remove`（已实现命令 34 → **37**）。要点：只认音频扩展名、**大小没变就不重读标签**、读不到标签也入库（标题退回文件名）、**清理只针对本次扫描范围**（非递归不误删子目录——测试抓到的真 bug）、进度经 `library:scan:progress`、`remove` 缺省只移出曲库（`deleteFile` 才删文件且只接受音频扩展名）。元数据用 **symphonia**（`lofty` 不在本机 registry 缓存，离线不可得）。
- **本地播放链路已完成（M3c）**：`playback.report` 写播放历史（与 `library.history.push` 同一实现，`source` 取**实际播成的**音源；`quality` 暂不落库——`RecentTrack` 没这列）；**本地文件改走同一条回环流代理**（`StreamTarget` 分远端/本地、`publish_local` 只接受音频扩展名、代理支持 `Range`/`206`/`416` 与按扩展名的 `Content-Type`、响应头不泄漏路径），`playback.resolve` 对 `local:` 引用直接发布文件、文件被删则继续回退（已实现命令 37 → **38**）。前端因此可以彻底去掉 Blob hack（服务层切换待做）。
- **下载已完成（M3d）**：迁移 **0006** `download_tasks` + `core/src/download.rs`，六条命令 + 三个事件（已实现命令 38 → **44**）；建任务立刻返回、后台线程流式写 `.part` → 完成后 rename；**暂停/续传**（`Range`；上游忽略 Range 时**从头写**，绝不把完整响应追加到半截文件后）；文件名来自曲目、真实扩展名按媒体地址改写并写回库；`remove` 缺省只删记录、`deleteFile` 才删文件；本地曲目不给下载；下载地址复用播放那套公网 HTTPS/防内网校验。`HttpTransport` 新增事件式流式接口 `download`（`Start` + `Chunk`，默认实现明确报错，避免将来退化成「先全下到内存」）。
- **皮肤已完成（M4b）**：迁移 **0007** `skins` + `core/src/skin.rs`（已实现命令 44 → **50**）：白名单**唯一来源是 `theme.config.json`**（`include_str!` 编进核心，不抄令牌名列表）；三层校验（结构 → `skin.invalid_document`、键名 → `skin.token_rejected` **全部列出被拒键名**、值类型 → 结构错误）；用户皮肤恒 `builtin: false`；激活存 `meta.skin.active`（删除激活皮肤时顺手清标记）；导入 `paste`/`file`/`url`（复用公网 HTTPS/防内网校验）、导出 `json`/`file`。`ImportSource` 提升到契约层（插件与皮肤同构）。
- **推荐已迁入核心（M4a）**：迁移 **0008** `recommend_feedback` + `core/src/recommend.rs`（已实现命令 50 → **53**）：画像与打分与旧前端 `src/utils/recommend.ts` **同一套行为**（12h 半衰期、播放次数取对数、收藏 2.5、歌手 1.6、理由优先级、强度归一化；7 项单测从 TS 断言移植）；**候选只来自本机数据**，`recommend.home` 零出网（ADR-0005，有测试断言）；`similar` 支持 `TrackRef`/`{albumId}` 种子；`feedback` append-only 落库并在下次打分时消费（like/unlike/skip/complete，快照缺了从本机库反查）。
- **插件域收尾已完成（M5a）**：`core/src/plugin_admin.rs` 落地最后 6 条命令——**契约命令全部点亮**。配置：乐观并发（冲突 `details.current`、不改动已存值、64 KiB 上限、写入后卸载运行时按需重载）；凭据：只读写**清单声明过**的键、空值拒绝、`status` 只回「是否已配置」（命令层没有读值出口，插件仍只能通过沙箱 `credentials.get` 只读访问）；检查更新：**只比对不自动更新**（url 下载比对版本+sha256 / catalog 比对本地缓存索引 / 本地来源返回 `null`）。**已知缺口**：凭据落点仍是内存实现（`keyring` 不在离线 registry 缓存）→ 重启失效，已在契约与 STATE 写明。
- **前端服务层开始切换到核心（R9）**：新增 `src/services/core.library.ts` 门面（收藏/歌单/历史/本地/下载的读与写 + `trackRefOf` 统一引用），`library.service.ts` 改为**桌面端优先走核心、浏览器退回 mock**（与 `catalogService` 同一策略，视图与 store 零分支）；store 写入改成**乐观更新 + 落核心**（收藏切换、歌单新建/改名/增删曲目、播放记历史、清空历史、移除本地曲目）。为「清空播放记录」补了 **`library.history.clear`**（契约 59 → **60** 条）——界面一直有这个入口，历史成为核心的事实来源后没有它等于该功能静默失效。
- 仍待做：**联网补跑 `pnpm tauri build` 出 MSI/NSIS 安装包**（离线已提供便携版 zip + 启动实测）；
  **macOS / Linux 的凭据库**（当前只有 Windows 接了系统凭据库，其它平台退回内存实现并在
  `credentialsBackend` 里如实上报）、**原生文件选择器**（`tauri-plugin-dialog` 不在离线缓存里，
  界面用「粘贴路径」替代）、**听感的最终确认**（端到端测试能证明「取到了正确的音频字节」，
  但「扬声器真的响了」只能人工听一次）。
- **刻意留白（有实现、有门面，没有界面入口）**：**两项**，都写进可达性守卫并每次打印理由——
  服务 `library.history.push`（写历史统一走 `playback.report`，前端不该双写）与
  action `actions.player.stop`（「停止」不是用户可见操作：播放/暂停由 `toggle` 负责，
  它是 store 的完整重置入口，冒烟测试用它复位）。
  历史上还有 `catalog.track`（R31 已接到播放条/歌词页封面）与 `catalog.recommend`（R29 已接到推荐页），
  `recommend.similar` 在 R22 已接到专辑/歌单详情页——**这三条都不再是留白**。
- **第三十二轮（R32）插件链路真实验收**：自写夹具插件在打包版里走通「导入 → 启用 → 流式搜索 → 播放 → 歌词 → 曲目详情」，
  当场抓出并修掉**搜索竞态**（本地插件返回太快 → 事件在订阅前丢光 → 界面永远卡「加载中」到 20s 超时）：
  `coreSearch` 改成先订阅再发命令 + 事件入队补投；冒烟 +1 竞态回归用例（并修掉假宿主等待订阅的假阳性）。
  （下一轮已澄清：那是我的坐标点偏了，卸载/二次确认本身正常——见 R33。）
- **第三十一轮（R31）曲目详情接线**：`catalog.track` 接上——播放时问一次源补曲目元数据（封面/专辑），
  `player.detail` + `detail ?? current` 渲染播放条与歌词页封面，切歌/停止清空；守卫白名单从 2 项缩到 **1** 项
  （只剩 `library.history.push`）；`pnpm smoke` 278 → **281**。
- **第三十轮（R30）真实应用验收**：新增 `scripts/capture-window.ps1`（`pnpm ui:capture`）——`PrintWindow(PW_RENDERFULLCONTENT)`
  截图 + `SetForegroundWindow`/点击/剪贴板粘贴/滚轮驱动界面 + `-AssertRendered` 判白屏；据此第一次**看着真实打包版**验收：
  深/浅主题、排行榜、本地音乐、插件、推荐、搜索，并**手点了一遍扫描流程**（扫描→新增 1→再扫→移除 1），
  日志同时给出 R27 事件名修复的运行时证据（`library:scan:progress` 真的推出去了，无 `事件推送失败`）。
- **第二十九轮（R29）界面可达性守卫**：新增 `scripts/check-reachability.mjs`（进 `pnpm verify`，五道关卡），
  静态算「界面 → store action → services → 契约命令」的可达性；它抓出并修掉**推荐负反馈从没接线**
  （切歌/播完报 `skip`/`complete`，暂停不算）、**源侧推荐没入口**（推荐页新增「来自当前音源」+「不感兴趣」）、
  **插件优先级绕过服务层**；负向测试证明「删掉入口调用」会让它失败退出。`pnpm smoke` 267 → **278**。
- **第二十八轮（R28）本地库入库入口**：`library.local.scan` 之前**没有任何界面入口**（桌面端本地音乐页永远空着），
  现在本地音乐页常驻扫描面板（多目录 / 递归 / 进度事件 / 统计 / 失败原因 / 结束后强制重读）；
  假宿主补成能推事件（按 Tauri 语义 + 事件名按 Tauri 字符集校验），事件链路第一次进冒烟；
  mock 只在**没有核心**（浏览器预览）时出现。`pnpm smoke` 247 → **267**。
- **第二十七轮（R27）事件名与源路由**：**事件名带点号被 Tauri 拒绝 → 桌面上 8 个事件全部推不出去**
  （流式搜索只能等超时、下载进度不动；命令返回值正常，所以测试全绿也发现不了）——契约名改成冒号分段
  `catalog:search:done` 这类，约束钉进 Rust 单测 + 契约守卫（事件升为文档 ↔ Rust ↔ 前端类型 ↔ 前端常量四处比对）+ 冒烟；
  同时修掉「内置演示源被送去问核心」的源路由问题（新增 `core.sources`，核心回 `not_found` 只当「不认识」）；
  `pnpm smoke` 236 → **247**，`cargo test -p gently-core` 200 → **202**。
- **第二十六轮（R26）测试隔离**：`core/tests/common/temp_dir()`（先清空 + 进程内自增）替掉 20 个测试文件的时钟命名；修复前约 1/6 偶发失败，修复后连续 12 次全量运行零失败。
- **第二十五轮（R25）假宿主**：`withFakeCore()`（只替换 `window.__TAURI_INTERNALS__.invoke`，用完恢复）让冒烟覆盖桌面端分支：核心优先读、错误码如实带出、未实现退回 mock、皮肤 active 端到端；`pnpm smoke` 228 → **236**。
- **第二十四轮（R24）皮肤裁决**：`resolveActivePreset()`（核心 active 优先、本地 id 必须仍存在）+ 只有用户皮肤才发 `skin.setActive`（内置预设发 null）。`pnpm smoke` 224 → **228**。
- **第二十三轮（R23）真实封面接入**：核心归一化补 `artwork`（多字段别名取第一个非空），前端 `trackCoverStyle()` 统一「有图用图 → 渐变 → 哈希兜底」，6 处渲染共用；本地文件内嵌封面未提取（已记缺口）。
- **第二十二轮（R22）相似推荐落地**：补测试 → 修掉专辑种子认不出与「把专辑自己推回来」
  两个 bug → 详情页新增相似推荐区块（理由可解释、没有邻居就不显示）；
  MSI/NSIS 打包再次实测仍卡在联网下载 WiX（离线交付仍是便携版 zip）。
- **第十八轮（R18）源报错如实呈现**：详情门面新增 `onError`（预期内失败保持安静）、
  榜单门面返回 `{groups|page, error?}`（核心报错时**不再退回 mock**）、榜单切片存结构化错误、
  界面区分「源报错」与「源没有榜单」，新增 i18n `page.ranking.sourceErrorTitle`。
- **第十七轮（R17）出包与可交付性**：`pnpm package:portable`（便携版 zip + SHA256）、
  真正的 README、日志按天落盘（保留 7 天）、dispatch 失败记错误码；
  **并据此修掉两个兼容缺口**：`require('x').default` 互操作、MusicFree 函数名别名映射
  （`getMusicInfo`/`getMusicSheetInfo`/`getTopListDetail`）。
- **第十五轮（R15）插件压缩包导入**：`core/src/plugin/archive.rs`（deflate-only zip，
  解压后归一化为目录包/单文件，防解压攻击四道限制 + 形态唯一），前端导入面板新增「本机路径」
  来源；`cargo test -p gently-core` 181 → **186**。
- **第十四轮（R14）专辑/歌单详情**：新增 `/collection/:kind/:source/:id`（一个页面覆盖
  `catalog.album` / `catalog.playlist`），`catalogService` 补两个详情门面（核心优先、mock 兜底、同形）；
  新增 `utils/cover.ts` 收口「图片地址 / 渐变 / 空值」三种封面来源（6 个渲染点），
  修掉桌面端封面一律透明（核心给 URL、推荐结果给空串）的显示缺口。
- **第十三轮（R13）排行榜按源分类树**：删除日期/热度这一整套没有数据支撑的 UI
  （3 个组件 + `utils/chart.ts` + 5 个类型 + 榜单切片 6 个字段），改为
  `catalog.topLists` → 分类树 → 选中项 → `catalog.topList` 翻页；
  token `components.chart` → `components.topList`；顺带修掉「mock 注册表与 store 插件列表
  各说各话」导致桌面端音源筛选为空、榜单默认源落到 mock 的真 bug。
- **第十二轮（R12）插件管理界面补齐**：`plugin-settings.tsx`（凭据 + 配置）与
  `subscription-panel.tsx`（订阅添加/刷新/移除 + 订阅内一键安装，同意语义不变），
  权限措辞抽到 `views/plugin/permissions.ts` 共用——R10 留下的 11 个插件管理命令封装至此全部有界面。
- **第十一轮（R11）M5 收口开始**：**错误码 → zh/en 文案全覆盖**（26 个码，`src/i18n/errors.ts`
  的 `errorText()`，冒烟守卫「每个码都有翻译」；插件导入 / 诊断 / 皮肤导入 / 下载失败都已切换）；
  `scripts/verify.mjs` 提供 **`pnpm verify`**（typecheck + smoke + check:contract + `cargo test`，
  离线默认 `--offline`）；诊断卡片补「日志目录」一行；修掉 `CoreEventMap` 里下载事件载荷与
  实际不符的 3 处并让下载失败原因按 `code` 本地化显示。同时清掉两处历史包袱：
  **删除 `<audio>` 的 Blob/`audio/mp4` hack**（`Content-Type` 由回环代理按扩展名补齐，
  `effective_content_type` 有 4 项单测）与**歌词接上 `catalog.lyrics`**
  （新增 `src/utils/lyrics.ts` 唯一一份解析器：LRC / 纯文本 / 翻译对齐；桌面端没歌词就是空，
  不再用生成数据糊弄）。
- **第十轮（R10）前端服务层切换收尾**：推荐页改走 `recommend.home`/`similar` 并**删除 `src/utils/recommend.ts`**
  （打分只剩核心一份），`src/mock/recommend.mock.ts` 提供浏览器预览的预置数据；播放历史改由
  `playback.report` 在「放完/切走/暂停/停止」时上报**真实秒数 + 实际播成的音源**（`recordPlay` 只留乐观 UI，
  不再双写）；新增 `core.plugin.ts`（更新检查 / 配置 / 凭据 / 订阅 / 订阅内条目）与 `core.skin.ts` + `skin.service.ts`
  （桌面端导入走 `skin.preview`→`skin.install`，被拒令牌键名原样带出，新增 i18n `skin.importRejected`），
  插件列表/启停/卸载与皮肤列表/激活/删除/导出全部接上核心；`scripts/check-commands.mjs` 升级为**双向**
  守卫（服务层命令名字面量全量扫描 + 60 条命令必须都有前端封装），并顺手修掉 4 处 `src/api/index.ts`
  与 Rust 返回不一致的类型。

## 验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | 通过（契约 v0.1 → v0.2 重写后均为 0 错误） |
| 冒烟测试 | `pnpm smoke` | **360/360 通过**（含「无宿主时门面读返回 null、写是安全空操作」、皮肤门面两条路径同形、歌词解析 5 项、每个错误码都有 zh/en 文案、插件管理面板渲染、榜单分类树 5 项 + 分页切片 4 项、详情门面 3 项 + 封面 4 项 + 详情页 3 种渲染、已中止/中止中的搜索立即收敛、相似推荐两种种子在浏览器下均为空、曲目封面优先级 3 项、皮肤选中裁决 4 项、**事件名传输字符集 1 项**、**窗口拖动区 / 最大化文案 / 歌词页不重复压栈 3 项**、**下载设置默认值与越界钳制 2 项**、**`pickQualityWithFallback` 5 项**、**歌词来源 / 手动歌词不被覆盖 / 偏移与钳制 5 项**、**桌面歌词载荷 / 偏移 / 按钮入口 / 空态 4 项**、**浏览器下缓存状态返回 `unsupported_platform` 1 项**、**pet 扩展点 6 项**（宿主无宠物渲染空、注册后出现容器、同 id 覆盖、旧注销不误删新注册、注销清空、只读快照）、**第三方授权 4 项**（浏览器下状态为 null、发起授权如实失败、声明 `@oauth` 才有入口且显示 scope、未声明则无入口）、**源收藏 5 项**（面板渲染 / 非核心源为 null / 分页带页码 / 末页无下一页 / 缺能力如实报 `not_implemented`），以及**假宿主下的桌面端分支 78 项**：核心在时只认核心那份（**不合并演示源/占位项**）、核心报错不拿 mock 冒充用户数据、错误码如实带出、演示源不问核心、按源搜索不静默换源、`not_found` 兜底、下载被拒要留原因且重试真的重建、**刷新下载列表不丢本机失败任务**、**本地曲目不提供下载入口**、**下载三个事件落到任务上**、**下载目录/缺档音质真的进 `download.create`**、**并发上限只放行一首且完成后自动续上**、**缓存状态按三类统计**、**清理缓存带 kind 并回统计**、**歌词搜索走核心并带回来源与候选曲目**、**流式搜索 partial/done 兑现 Promise**、**扫描面板的进度/统计/失败**、**歌词只问插件源（本地曲目不问）**、**皮肤导出只对用户皮肤问核心**、**皮肤导入两条来源（paste/file）**、皮肤 active 端到端、**推荐空 bundle（核心在时不编造）**、**当前音源读核心清单**、**扫描统计带非音频文件数**、**授权四条命令的参数与命令名**、**授权地址真的交给 `plugin:opener|open_url`**、**`auth:changed` 事件刷新授权状态**、**源收藏走核心并带分页与错误码**） |
| 前端接入 | 设置页「本机核心」诊断卡片 + `core.bridge.ts` | 浏览器显示「浏览器模式」并退回 mock；桌面端显示核心版本/平台/数据库状态/统计/数据目录与日志目录（各自一键打开） |
| 核心单测 | `cargo test -p gently-core` | **241/241 通过**（R61 +3：收藏夹列表/作用域、缺能力返回空、以及一项**恢复运行**的缓存原子性测试（R60 +1：`catalog.favorites` 归一化/分页/不缓存 + 能力缺失/未安装/禁用三种错误码（R59 +16：`core/tests/oauth.rs` 6 项（完整授权链路 / `state` 不匹配 / 取消与退出登录 / 过期续期 / 未声明与未安装报错 / 换令牌失败）+ `oauth.rs` 单测 6 项（base64url、百分号编解码、回环判定、随机串、过期余量）+ 清单 `@oauth` 4 项；R58/R57 无 Rust 改动；R56 +1：播放缓存——后台补全、停用源后 `fromCache` 仍可播、清理后返回 null；R55 +1：`catalog.lyricsSearch` 跨源收集、跳过无词条目、`skippedSources`、歌词缓存命中、空关键词报错；R53 +6：`.m4s` 入库 / 扫描 `ignored` / 兼容参数形状 ×2 / 播放解析用原始条目 / `accept-encoding` 归一到 identity）（连续多次全量运行零失败；测试目录由 `core/tests/common/` 统一提供）（信封、26 错误码、70 命令均被路由、目录白名单、迁移幂等、FTS5、清单解析、`plugin.preview`、插件安装/卸载/状态、压缩包导入 5 项、沙箱 27 项、兼容清单合成 8 项、CommonJS/垫片 9 项、系统凭据库 2 项、日志日期解析 2 项、**事件名传输安全 2 项**、**封面缓存 5 项（命名确定性 / 重复分隔符同键 / 归一化规则 / 穿越与非法名被拒 / 写读删往返）**、兼容模式 28 项、详情 11 项、流式搜索 6 项（含取消后仍收敛）、本机库 9 项、**本地曲库 10 项（`.m4s` 走 isomp4 入库、mp3 与 FLAC 两条封面提取路径各一个手写夹具端到端、快照封面地址重新签发、重复路径不重复入库、清理重复行不误删封面、扫描幂等、清理范围、检索、移除）**、本地播放 2 项、媒体代理 5 项（含缓存离线）、下载 5 项、皮肤 8 项、**推荐 13 项**（含专辑种子与多条排除）、插件管理 3 项、整链路端到端 1 项） |
| **整链路（自动化）** | `cargo test -p gently-core --test e2e_chain` | 通过：导入插件 → 流式搜索（事件）→ 扫描真 WAV → `playback.resolve` 回环代理 → **真 HTTP 取流**（200/206/416 + `audio/wav` + 字节一致）→ 收藏/歌单/历史 → 重开库仍在 |
| **便携版打包** | `pnpm package:portable` | 通过：`release/gently-0.1.0-windows-x64.zip`（116.2 MB，内含 exe 127.3 MB + README + 便携说明；`release/gently-0.1.0-windows-x64.zip.sha256` 记的是 **exe** 的 sha256，当前 `6dfaa977…1b22`） |
| **打包版启动实测** | 解压便携版 → 运行 exe（`GENTLY_LOG=debug`） | `凭据存储已就绪 backend="windows-credential-manager"` → 迁移 8 条 → 数据库就绪 → 命令全 `ok=true`，**0 条警告**（R27 修前每次启动必现两条 `插件未安装：mock`）；事件名走 Tauri 校验字符集（`catalog:search:*` / `library:scan:progress` 等）。**说明**：扫描 / 推荐 / 反馈这些「要人点一下」的路径不进启动日志，它们由假宿主断言 + 核心单测覆盖 |
| 契约守卫 | `pnpm check:contract` | 文档 ↔ Rust ↔ 前端一致（**70 命令 / 9 事件 / 26 错误码**；事件为**四处**比对：文档 §3 ↔ `events::ALL` ↔ `CoreEventMap` ↔ `CORE_EVENTS`，并校验字符集；服务层 70 项命令名全部在契约内，且契约命令 70/70 都有前端封装） |
| 交付前验证 | **`pnpm verify`** | 一条命令跑完**五道关卡**（typecheck / smoke / check:contract / **check:reachability** / `cargo test -p gently-core`），全部通过 |
| **界面可达性守卫** | `pnpm check:reachability` | 通过（服务节点 164 / 动作节点 72 / 界面文件 145）：所有契约能力都能从界面走到；有意不做入口 **2** 项（服务 `library.history.push` + action `actions.player.stop`，理由分别写在脚本的 `DELIBERATE` / `DELIBERATE_ACTIONS` 里且每次打印；白名单条目一旦被接上界面会反过来提醒删掉）。**负向测试**：删掉扫描面板的 `scan(...)` 调用 → 立刻报 `libraryService.scanLocal → library.local.scan` 并退出 1 |
| **真实应用验收（R30）** | `pnpm ui:capture -- -Launch …` | 通过：`-AssertRendered` 退出码 0（抽样 165 种颜色）；**看着真实打包版**确认深/浅主题、排行榜、本地音乐、插件、推荐、搜索六张图（`release/screenshots/`）；并在界面上手点完整扫描流程：填目录 → 扫描（日志 `library.local.scan ok=true scanned=1 added=1`）→ 表格出现探针曲目 → 删文件再扫 → 「移除 1」回到空态。**同时**是 R27 事件名修复的运行时证据：`library:scan:progress` 推出时日志**无** `事件推送失败` |
| Rust 构建 | `cargo build -p gently` | 通过（复用既有依赖缓存；产物固定在 `src-tauri/target`） |
| **打包（release）** | `pnpm tauri build --no-bundle` | 通过，产出 `src-tauri/target/release/gently.exe`（126.8 MB，release profile 0m52s） |
| **打包实测启动** | 运行 release `gently.exe`（`GENTLY_LOG=debug`） | 迁移 8 条应用（`schema_version=8`）→ 数据库就绪 → React 挂载后真实命令全部 `ok=true`：`plugin.list` / `system.status` / `library.favorites.list` / `library.playlists.list` / `skin.list` / `system.paths` |
| 安装包（MSI/NSIS） | `pnpm tauri build` | **离线受阻**：Tauri 需要先下载 WiX（`github.com/wixtoolset/wix3`）才能打 MSI，本机无网络且 `%LOCALAPPDATA%\tauri` 无缓存 → 已用 `--no-bundle` 验证到「可执行文件 + 启动链路」，安装包待联网补跑一次 |
| 启动实测 | `cargo run -p gently` | 迁移 0001 应用、WAL 生效、库落在 `%APPDATA%\com.xun.gently\gently.db` |
| **端到端链路** | `pnpm tauri dev`（`GENTLY_LOG=debug`） | 日志出现 `DEBUG dispatch command="system.status" ok=true`：React 挂载 → `probeCore()` → `invoke('core_invoke')` → Tauri 参数解析 → `spawn_blocking` → core 分发 → 信封回传，全链路打通 |
| 前端生产构建 | `pnpm build` | 通过，主包 366.62 KB（gzip 119.67 KB） |
| 残留引用 | 搜 `@gently/server` / `server/src` | 0（配置、锁文件、文档均已清理） |
| 消费方影响 | 全仓搜 `src/api` 导入 | 0——契约是纯类型，UI/store/services 未被波及 |

## 下一步

**当前（R58 之后）还差的事**：

| 待完成项 | 状态 | 下一步 |
|---|---|---|
| 5. 1.x / 2.x 版本与 pet 接口 | **接口已预留**（ADR-0007 + `src/pet/`） | 已拍板：**不提前提 1.0.0**，等功能项全部验收；宠物实现留到 2.0 |
| 6. OAuth2 第三方授权 + 源收藏 | **已完成（R59 抽象 + R60 收藏夹）** | 具体源（B 站等）由用户装的插件实现；应用不内置任何第三方实现 |
| 7. 主题控制面板 | **已拍板：不做** | 只保留主题市场 + 明暗切换，`theme.config.json` 仍是唯一入口（ADR-0007 §1.1） |
| 下载逻辑收尾 / 缓存上限自定义 | 部分完成 | 视用户优先级排 |

以下是 M0–M5 的原始计划（历史，已全部收口，保留以便追溯）：

计划与退出标准见 **`docs/ROADMAP.md`**（M0 骨架与契约 → M1 插件宿主与分发 → M2 播放链路 →
M3 本机库与持久化 → M4 推荐与皮肤 → M5 收口交付）。要点：

| 项 | 结论 |
|---|---|
| Cargo 结构 | workspace：`core`（不依赖 tauri，可独立 `cargo test`）+ `src-tauri`（薄适配层） |
| 存储 | rusqlite（bundled）+ 单写线程 + WAL + FTS5 + `user_version` 迁移（`docs/adr/0004-local-storage.md`） |
| 职责边界 | **前端只做 UI 与渲染；数据处理与算法（含推荐打分）归 core**；同一算法只允许一份实现 |
| 首个插件 | demo 插件（移植现有 mock 源）+ 故意越权的测试插件 |
| **第三方资源立场** | **不内置/不推荐/不预置任何第三方入口**（无默认订阅、无预置仓库、无推荐位）；导入必须由用户提供来源；用户动作前零外部请求；示例只用 `example.com` 占位（ADR-0005，硬约束） |
| 插件形态 | **单文件 JS（头部注释元数据）为主，目录包为高级形式**；分发靠订阅 `repository.json` |
| 媒体传输 | **核心内建仅回环流代理**（Range + 头部注入 + SSRF 防护）；本地文件走同一通道 |

顺序与退出标准：

1. **M0 骨架与契约**：Cargo workspace、信封/错误码（含 `plugin.invalid_source`/`subscription.*`/
   `media.*`）/tracing、`system.*` 真实现、其余 **57 条命令**注册骨架返回 `common.not_implemented`；
   `specta` 生成绑定 + `check-commands` 文档↔注册表一致性守卫；
2. **M1 插件宿主与分发**（最大不确定项）：**单文件 JS + 头部元数据解析**（目录包为高级形态）、
   9 函数 ABI 与能力探测、QuickJS 沙箱 + `hosts` 白名单、六种导入来源 + `preview`/同意/`import`、
   keyring 凭据、**订阅 `repository.json` 索引 + `plugin.catalog.list` + 一键安装**、作者自测 CLI；
3. **M2 播放链路**：**流式搜索**（`searchId` + 事件 + 分源视图）+ 按源分类树渲染排行榜、
   catalog 聚合去重排序 + `playback.resolve` 回退链、**本地流代理（Range/头部注入/SSRF 防护）**、
   前端 catalog/audio 切命令层；
4. **M3 本机库与持久化**（可与 M1/M2 并行）：SQLite 表与迁移（含 `subscriptions`）、
   收藏/歌单/历史、本地扫描 + FTS5、下载任务与事件、**本地文件播放改走同一流代理**（删 Blob/`audio/mp4` hack）；
5. **M4 推荐与皮肤**：推荐画像与打分**迁入 `core/recommend`**（同夹具对比后删除 TS 实现，
   mock 改预置数据）；皮肤令牌白名单校验与导入导出；
6. **M5 收口**：诊断页、错误码→zh/en 文案、`pnpm verify` 一条命令、`pnpm tauri build` 实测出包。

## 风险

- **命令清单仍需逐条确认落地**：`auth.*` 已删、市场写操作改为导入/导出，其余命令待 Rust 侧核对；
- **社区插件是不可信代码**：沙箱与安装期同意是硬要求——不做就等于让用户执行陌生代码；
- **无遥测**：线上问题只能靠本地诊断页与用户主动提供的日志；
- 皮肤令牌键名白名单目前只有契约，尚无实现；推荐算法的 Rust 迁移需防行为漂移（见 ROADMAP §6）；
- **单实例假设**：SQLite 单写线程 + 内存缓存要求单实例，M0 需引入单实例守卫；
- **生态冷启动**：零插件则播放器不可用——**不靠推荐资源解决**（ADR-0005 禁止预置第三方入口）：
  无插件时应用本身可用（本地文件播放/播放器/歌词/皮肤/本地库）+ 插件页给出三种导入方式的中性说明
  （不写具体地址）+ 单文件格式降低作者门槛 + 订阅一键装（用户自填 URL）+ 作者自测 CLI。
- **恶意媒体地址 SSRF**：插件可借本地流代理访问本机/内网——代理层阻断内网/回环/链路本地地址
  （`media.blocked_address`）；
- 视觉 / 交互正确性：**R30 起可以自己截屏 + 驱动界面验收**（`pnpm ui:capture`，仅 Windows），
  不再是「环境无法截图」；但**听感**（扬声器真的响了）与**安装包在干净机器上跑通**仍需要人 / 联网各一次。
