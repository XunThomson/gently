---
status: active
last_verified: 2026-11-01
owner: gently
scope: 非显然的坑与规避方式（从历史轮次中提炼）
token_budget: 1500
tldr: 只保留「不读就会再踩」的坑：现象 → 根因 → 规避 → 验证口径。历史过程见 docs/archive/rounds/。
---

# GOTCHAS

> 这些不是教程，是已经真实踩过、且**从代码看不出来**的坑。新增条目请附来源轮次与验证方式；
> 轮次过程与证据文件在 [`archive/rounds/R01-R83.md`](archive/rounds/R01-R83.md)。

## 1. 无边框窗口四周 8px「没人画」的空洞（R70）

- 现象：窗口 resize 后边缘像素错位/露出下层窗口。
- 根因：`decorations:false` 且 `shadow:true`（默认）时，DWM 按 `frame_thickness` 把客户区缩进 8px 画投影；
  无边框 popup 上 DWM 并不画 → 8px 无人绘制。
- 规避：主窗口 `"shadow": false`（客户区铺满整窗），同时 `shadow:false` 下 hit-test 四边完整，resize 不受影响。
- 验证：窗口 rect 起点与首个内容像素重合；从 1000×700 / 1600×950 拉回 900×600 差异像素为 0。

## 2. Tauri 事件名带点号会整条丢失（R27）

- 现象：命令返回 `ok`，但前端永远收不到事件（流式搜索超时、下载进度不动）。
- 根因：Tauri 事件名只接受字母数字与 `- / : _`，点号被拒绝，`emit` 静默失败。
- 规避：事件名一律冒号分段（`catalog:search:done`）；运行时常量在 `src/services/core.events.ts`，契约守卫双向比对。
- 验证：`core/events` 单测 + `check-commands` 字符集检查。

## 3. 演示数据只能出现在浏览器预览（R53）

- 现象：桌面端显示「插件未安装：mock」，或核心读失败却看到假数据。
- 根因：三个演示源无条件注册；插件列表把演示源/占位项合并进核心清单。
- 规避：`src/plugins/index.ts` 只在**没有 Tauri 宿主**时动态注册演示源；核心存在却读失败时返回空并如实报错，
  **不能拿 mock 冒充用户数据**。
- 验证：`withFakeCore()` 下各门面返回空/错误码；冒烟断言核心优先。

## 4. 播放失败不能只置 `playable:false`（R71）

- 现象：播放条显示在播、进度在走，但完全没声音，也没有提示。
- 根因：解析失败/媒体报错只把 `playable` 置 false，`playing` 仍 true，回退时钟继续推进。
- 规避：失败即停表、写入 `playbackError`（`noSource` / `media` + 已试源）；播放条与迷你播放器都必须
  显示原因与重试入口（共用 `utils/playbackFailure.ts`）。
- 验证：store 的失败/重试/换源断言；`player-bar: 播放失败时显示「无法播放」与「重试」`；迷你同源。

## 5. 网易云 `803` 可能只回游客令牌（R81/R82）

- 现象：登录显示成功、「已配置」，但收藏/用户信息永远空。
- 根因：`interface.music.163.com` + `type=3` 的 803 只下发 `MUSIC_A_T`（25 个），没有 `MUSIC_U`；
  游客令牌不是登录态。
- 规避：只认 `MUSIC_U`；只拿到游客令牌就抛错不写凭据；8821 先按「已扫码」、约 12 秒后才判过期。
- 验证：离线夹具区分「803 带 MUSIC_U」与「只有 MUSIC_A_T」；真实账号需用户自己登录（不要在代码里预置凭据）。

## 6. 二维码确认窗口只有约 2 秒（R81/R83）

- 现象：扫码成功但轮询来不及拿到 803。
- 根因：服务端二维码确认窗口约 2 秒，人工操作很难抢在轮询周期内。
- 规避：二维码只作尽力而为入口；主路径是「打开登录页窗口 + 自动读 webview 会话」（`catalog.loginWeb`），
  不模仿第三方登录接口、不绕过风控。
- 验证：本机回环探针可在 700ms 内读到 Cookie；真实站点登录需用户手动完成一次。

## 7. 媒体代理不跟随 302 会被 WebView 当混合内容拦掉（R82）

- 现象：播放条在走、没有声音；日志显示上游 302。
- 根因：代理 `redirects(0)` 把 302 原样交给 `tauri://` 页面，页面跟随到 `http CDN` 属混合内容。
- 规避：代理自己跟随（≤3 跳）并转发 Range；只服务回环 token + 白名单目录。
- 验证：起两台本地 HTTP 服务的 302 回归测试；真实源收藏曲目从卡 0:00 变为正常播放。

## 8. 皮肤 `builtin` 不能靠数据文件自觉（R51）

- 现象：内置皮肤卡片长出「删除皮肤」，点了提示已删除但卡片不动。
- 根因：`presets.json` 从未写 `builtin`，视图守卫 `!item.builtin` 失效；核心又不认识内置预设。
- 规避：`presets.ts` 给所有内置皮肤统一补 `builtin: true`；删除/导出读同一个标记。
- 验证：冒烟断言「内置预设全部带 builtin」；打包版内置卡片无删除入口。

## 9. 皮肤令牌白名单删除键会让旧皮肤整份失败（R84）

- 现象：旧版本导出/分享的皮肤在新版本导入时报 `skin.token_rejected`。
- 根因：核心用当前 `theme.config.json` 做白名单，任何未知键都会让整份皮肤失败；
  R84 删除了 `lyrics.activeFontSize/activeBg/guideColor/guideWidth`。
- 规避：`core/src/skin.rs` 有界 `RETIRED_COMPONENT_TOKENS` 白名单，接受但丢弃并给 warning；
  **不能**放宽成「未知键都接受」。
- 验证：`retired_lyric_tokens_are_accepted_but_dropped`；旧皮肤可 preview/install 且不含退役键。

## 10. `track.id` 已经带源前缀，别再拼一次（R68）

- 现象：手动挑过歌词后，重播取不到那份词，静默退回源歌词。
- 根因：核心给的 `track.id` 已是 `source:rawId`，再拼 `lyrics:<source>:<id>` 得到双前缀。
- 规避：统一走 `utils/lyricsSyncCache.ts` 的 `rawTrackIdOf` / `appliedLyricsRef`；取词引用只拼一次。
- 验证：冒烟的歌词来路/完整引用断言；打包版切歌再回仍保留手动来路。

## 11. 本地扫描：`.m4s`、路径归一化、ID3 链式元数据（R37/R53）

- 现象：目录有文件却扫描为 0；同一文件收成两行；mp3 标签/封面读不到。
- 根因：白名单漏 `.m4s`；Windows 路径分隔符/重复分隔符未归一化；symphonia 的 ID3v2 在链式元数据里。
- 规避：补 `m4s/m4b/m4r` + `ignored` 统计；路径归一化一份实现；mp3 同时读链式元数据。
- 验证：扫描夹具（mp3/flac/无封面/m4s/重复分隔符）+ 1000 文件性能测试。

## 12. 无边框窗口拖动靠 `data-tauri-drag-region`（R54）

- 现象：`decorations:false` 后窗口完全拖不动。
- 根因：没有声明拖动区；Tauri 按 mousedown 路径判定，按钮/输入框会阻断，空白区需要属性。
- 规避：标题栏 `data-tauri-drag-region="deep"`；迷你播放器只把拖动区放在顶栏（不要铺满整页，
  否则 `SeekBar` 的 div 拖拽会变成拖窗口）。
- 验证：打包版拖动；迷你进度条可拖、顶栏可拖。

## 13. `prefers-reduced-motion` 默认让视频背景不渲染（R85）

- 现象：设置页显示已导入视频、`localStorage`/IndexedDB 都有数据，但页面上没有 `<video>`、
  `data-video-bg` 也不存在。
- 根因：`BackgroundVideo` 默认尊重系统「减少动态效果」设置，直接返回 `null`；不是导入失败。
  **不是强制**：设置页有「减少动态效果 → 仍然播放」，用户显式覆盖后会正常渲染。
- 规避：测试时用 DevTools `Emulation.setEmulatedMedia` 把 `prefers-reduced-motion` 设为
  `no-preference`；或把设置切到「仍然播放」/检查 `matchMedia(...).matches`。
- 验证：Chrome CDP 注入文件后 `video.src=blob:`、`readyState=4`、`data-video-bg="on"`。

## 14. 网页壁纸的 JS 不能靠 iframe 沙箱断网（R85）

- 现象：以为 `sandbox` + CSP `connect-src 'none'` 就安全，但网页脚本仍可 `location = 'https://…'`
  把 iframe 自己导航到外网；CSP 的导航指令在现代浏览器并不可靠，网络请求已经发生。
- 根因：`sandbox` 默认只禁止**顶层**导航，不禁止 iframe 自我导航；`navigate-to` 不是可依赖的 CSP 指令。
- 规避：只支持**静态单文件 HTML/CSS**：iframe `sandbox=""`、CSP `script-src 'none'`，并在包装层删掉
  **全部 `meta` / `base`**（不要只匹配 `http-equiv="refresh"`，实体编码可绕过）；脚本、外链、表单、
  frame/object 全部禁止。带 JS / 多文件的 Web 壁纸需要独立 WebView 并在原生层拦截导航，不能只靠 iframe。
- 验证：冒烟断言包装层同时含 `script-src 'none'` / `connect-src 'none'`，并移除实体编码的
  `meta refresh` 与 `base`；导入含 `<script>` 的 HTML 时页面只显示静态部分。

## 15. 候选 `qualities` 不能写死成 standard（R86）

- 现象：清单声明 `@qualities high,standard`，播放/下载却始终按 standard 问插件；
  只实现 standard 的插件在默认 `preferredQuality=high` 时返回 null，整首歌显示“无法播放”。
- 根因：核心 `merge_tracks` / `catalog_detail` / 收藏快照曾把 `qualities` 固定成
  `["standard"]`；前端又直接用全局 preferredQuality，没有按源降级。
- 规避：候选 qualities 必须来自插件清单（`PluginHost::qualities`）；前端用
  `pickQuality(candidate.qualities, preferredQuality)` 取该源实际支持的档位。
  清单只代表“声明能力”，单曲是否真的能拿到仍以 `getMediaSource`/`ResolvedMedia.quality` 为准。
- 验证：核心 merge 测试断言候选保留 `["high","standard"]`；冒烟断言
  `pickQuality(['standard'], 'high') === 'standard'`。

## 16. `backdrop-filter` 会创建 stacking context，搜索面板会被内容盖住（R86）

- 现象：搜索建议面板明明有 `z-index: dropdown`，榜单/表格仍画在它上面。
- 根因：标题栏使用了 `backdrop-filter`，本身成为独立的 stacking context；标题栏没有
  显式 z-index，后绘制的路由内容自然盖过整个标题栏层。
- 规避：给标题栏 `position: relative; z-index: var(--z-dropdown)`；面板的 z-index 只在
  这个上下文内比较，不要再给路由内容加更高的 z-index 去“压回去”。
- 验证：打包版搜索「南」时建议面板完整盖住排行榜表格（`r86-search-overlay.png`）。

## 17. 播放进度每 250ms 更新，整页订阅会让负载时更卡（R86）

- 现象：电脑负载高时界面掉帧，播放/歌词页尤其明显；只是暂停播放就缓解。
- 根因：`NowPlayingView` 直接 `usePlayerState()`，timeupdate 每次都让整页（封面、标题、
  工具抽屉、歌词列表）重渲染；歌词行也没有 memo，300 行全部参与 reconciliation。
- 规避：稳定数据用字段 selector；只让 `NowPlayingLyrics` 订阅 `elapsed/offset`；
  播放条的进度条/时间拆成 `PlayerSeekBar` / `PlayerTime`；歌词行、`SourcePicker`、`QualityPicker`
  用 `memo`，避免父级进度更新带着重渲染。背景在窗口失焦时**暂停视频但保持挂载**，
  不把壁纸卸载掉；恢复焦点后继续播放。
- 验证：`pnpm typecheck && pnpm smoke`；真实负载下的 FPS/长任务仍需在 WebView2 里单独测，
  不能拿 headless 的 144fps 当作达标。

## 18. 网页目录选择器与 CDP 自动化（R86）

- 现象：用 `DOM.setFileInputFiles` 给 `webkitdirectory` 输入框塞 3 个文件，React 的
  `onChange` 不把目录内容交出来，界面仍显示“还没有选择目录”。
- 根因：目录输入框要求一个目录选择结果，不是普通多文件列表；自动化塞单文件路径不等价。
- 规避：手动测试用原生目录选择器；浏览器自动化验证内联逻辑时，可先临时移除
  `webkitdirectory` 属性再塞多个文件（此时 `webkitRelativePath` 为空，按文件名解析）。
  打包版的原生目录选择器仍需人工走一次。
- 验证：`r86-wallpaper-assistant.png`；设为背景后 `index-inline.html` 的 iframe `srcdoc`
  不含 `<script>`，且 `sandbox=""`。

## 19. 内容/抽屉透明度不能用容器的 `opacity`（R86）

- 现象：想调卡片/外壳透明度，直接给容器 `opacity`，文字、图标、边框一起变淡，违反
  “不包括字体”的要求。
- 根因：`opacity` 作用于整个渲染子树；它不是背景色属性。
- 规避：只改表面 token 的 alpha：`BackgroundVideo` 在背景开启时直接写入
  `--surface-chrome` / `--surface-content` / `--surface-content-alt` / `--surface-elevated`
  （`color-mix(in srgb, var(--bg-surface) N%, transparent)`），**不要复用主题 token 名**
  （例如不要新增 `--content-surface-opacity` 再让 ThemeProvider 注入）。ThemeProvider 在
  切深浅色时会重注入自己的 token，同名动态值会被覆盖，表现为“切一次主题就把内容透明度/虚化重置”。
  组件只消费这些 surface 别名；搜索框、标签、主题卡片不要再用不透明的 `--bg-subtle` 等，
  否则会出现“部分组件元素不统一”。
  抽屉/浮层不要和内容共用一个值：菜单、面板、搜索建议、收藏夹选择器、歌词工具抽屉使用
  独立的 `--surface-drawer` / `--surface-drawer-blur`，由 `drawerOpacity / drawerBlurPx` 驱动，
  这样用户可以在设置页分别调“内容”和“抽屉”，而不是被迫一起变。
  虚化同理只改 `--surface-blur` / `--surface-drawer-blur`（backdrop-filter），
  不要给容器 `filter: blur()`；0 时写 `none`，避免 `blur(0px)` 仍创建合成层。
- 验证：CDP 把内容透明度从 66% 调到 20%、内容虚化调到 8px，抽屉调到 70% / 4px，
  再点灯泡切深浅：内容滑杆仍 20/8、抽屉 70/4，inline `--surface-content` 仍是
  `color-mix(... 20%, ...)`、`--surface-drawer` 仍是 `color-mix(... 70%, ...)`；
  light/dark 下卡片 alpha 都是 .2、搜索建议面板 alpha .7 且 blur 4；文字颜色不变。
  截图 `r86-content-opacity.png` / `r86-content-blur.png` / `r86-surface-drawer.png`。

## 20. 插件导入后「要重启才生效」（R87）

- 现象：导入插件成功，但插件页表格、音源筛选、播放条音源选择器都还是旧清单；
  搜索结果像是没装这个源。
- 根因：`PluginActions.load()` 有 `loaded` 守卫（启动时读过一次就再也不读）；
  导入面板又自己 `plugin.list` 了一份「已导入」，装完只刷新了它自己那份。
  同时 `core.sources` 的按源路由缓存也还认为这个 id 「不属于核心」。
- 规避：任何改变插件集合的动作（导入 / 订阅安装 / 启停 / 卸载 / 改优先级）之后
  必须调 `plugin.reload()`（强制重读 + `invalidateCoreSources()`）；
  列表只留 store 那一份（视图不要各自 `plugin.list`）。
- 验证：`smoke` 的 `fake: plugin.reload() 立刻读到新导入的插件（不需要重启）`。

## 21. 异步「按选中项取列表」必须带请求代号（R87）

- 现象：快速点两个 tab / 两个音源，标签停在 B，内容却是 A 的；收藏页「源收藏」稳定复现。
- 根因：响应没有序号，谁后到谁写 state；A 的请求比 B 慢就盖掉了 B。
  另一类写法（「collections effect + load effect」两条互相触发）会在换源瞬间
  用**上一个源**的参数发一次请求，再被下一次覆盖。
- 规避：换源/换分类时先 `++seq` 并**清空列表**，回包时用 `ticket !== seq` 丢弃过期结果；
  一条链（换源 → 取子列表 → 取第一页）收在**一个** effect 里。
- 验证：`smoke` 的 `fake: 旧分类的迟到响应被丢弃（标签与内容不会错位）`（可控延迟的假宿主）。

## 22. 休眠回来放不了：媒体元素状态 + 流地址 TTL（R87）

- 现象：电脑睡一觉回来，界面还显示「播放中」但没有声音；点播放/暂停没用，只能重播。
- 根因：① 系统掐断媒体元素（`paused` 变 true 或元素进 error 态），`audioUrl` 没变 →
  没有 effect 重跑，没人去把声音叫回来；② 回环流代理 token 只有 **30 分钟** TTL、
  上游直链更短，旧地址必然失效；③ `audioEngine.load()` 对同地址直接 return，
  error 态永远修不回来。
- 规避：`audioEngine.load()` 在 `error` 存在时不跳过；`resume()/reload()/hadError()` +
  在 focus / visibilitychange / pageshow / 5s 心跳上做恢复；恢复失败且是错误态 →
  `recoverPlayback()`（重新解析、**保留进度**）。媒体报错时另给同一批源**一次**
  自动重解析机会（按 `playId` 限次）。
- 验证：`smoke` 的 `store: 休眠回来媒体报错会先自动重新解析并接着播（进度不丢）`
  与 `自动重解析也只给一次` 两条。

## 23. 契约命令数有**三处**硬编码断言（R87）

- 现象：新增命令后 `check:contract` 绿了，`cargo test` 却红。
- 根因：`core/tests/contract.rs`、`core/tests/dispatch.rs`、`core/tests/plugin_preview.rs`
  各有一处 `assert_eq!(command_count()/implemented_count(), N)`。
- 规避：加命令时一次改全（文档 §2 + `COMMAND_NAMES` + 分发 + `IMPLEMENTED` + 上述三处）。
- 验证：`pnpm verify`。

## 24. 时钟偏斜会让 cargo 复用旧的 core rlib（R87）

- 现象：`core/src/paths.rs` 明明新增了 `pub fn`，`cargo check -p gently` 却报
  `cannot find function ... in module gently_core::paths`；`cargo check -p gently-core` 秒过。
- 根因：本机时钟被改过，产物 mtime 比源码新，cargo 判定「已是最新」不重编。
- 规避：`cargo clean -p gently-core` 后重编（不必整仓 clean）。
- 验证：clean 后同一条命令通过。
## 25. 内部标记枚举的字段名不会跟着 `rename_all` 变（R88）

- 现象：`pet-core` 的 `pet.json` 里写 `"then": {"kind": "say", "textKey": "pet.idle"}`，
  反序列化报 `missing field text_key`——明明整个枚举都标了 `rename_all = "camelCase"`。
- 根因：`#[serde(rename_all = "camelCase", tag = "kind")]` 只改**变体名**
  （`playing` / `silentFor`），结构体变体的**字段名**不受它影响。
- 规避：再加上 `rename_all_fields = "camelCase"`（serde ≥ 1.0.181；本机 1.0.229），
  或对每个字段单独 `#[serde(rename = "textKey")]`。凡是给用户/社区写的 JSON 格式都要按 camelCase 锁一次。
- 验证：`cargo test -p pet-core`（`invalid_specs_are_rejected_with_readable_reasons` 也用同一份 JSON）。

## 26. 独立性守卫会把注释里的库名也算违规（有意严格，R88）

- 现象：`pet-core/src/store.rs` 的文档注释里写了「不要共用 `<音乐库文件名>`」，`pnpm check:pet` 直接失败。
- 根因：守卫按**整个文件文本**匹配禁用标记（`gently_core` / `tauri::` / 音乐库文件名），
  注释也在射程内——这是刻意的：一行注释往往是「以后就这么写」的开端，而守卫要能一眼看懂。
- 规避：解释「为什么不要耦合」时用「音乐库」这类**概念词**，不要写出具体文件名/模块名；
  确实要在注释里提代码标识符时，改写措辞即可（不要放宽守卫）。
- 验证：`pnpm check:pet` / `pnpm verify` 的第 6 道。

## 27. 白底 sprite sheet 直接当图集 = 一个白方块（R93）

- 现象：宠物包导入成功、面板也显示它出战，但右下角出现的是「一张带底色的矩形图」。
- 根因：图集按原图逐格画（`background-position`），**没有任何抠图**；用户素材常是白底/黑底 png/webp，
  透明通道才是「只有角色」的前提。`VP8L` 的 webp 若没有 ALPH 块，就根本存不下透明。
- 规避：渲染前先判断「这张图有没有透明像素」；没有就用角落底色 + 容差把底色抠成透明
  （`src/pet/atlas-matte.ts` 的纯函数 + `core-pet.ts` 里一次 canvas 处理，R96 起自动做）。
  抠底容差 18/通道：太小留白边，太大会吃掉浅色羽毛；全不透明的深色满幅图不抠（避免把整只宠物抠没）。
  规范里仍要求作者**主动给透明图集**（`docs/pet-package.md` §3），自动去底只是兜底。
- 验证：`pnpm smoke` 里四条断言（需要去底 / 只清底色像素 / 带 alpha 不动 / 深色不抠）；
  打包版实图 `release/screenshots/r93-pet-sprite.png`（角色周围是页面背景，不是白框）。

## 28. Windows 上解 webp 只有 Chromium 可信（R93）

- 现象：同一张 `examples/spritesheet.webp`，用 `System.Drawing` 直接报「参数无效」，
  用 WIC（`BitmapDecoder`）能开但解出来是**黑底 + 彩色条纹**（和真实像素完全不符）。
- 根因：GDI+ 没有 webp 解码器；WIC 的 WebP 扩展对本机的 `VP8L`（无损）支持不完整。
- 规避：把图丢进 `msedge --headless=new --screenshot=out.png --window-size=W,H`（页面里 `<img>` 1:1 铺开），
  得到一份**普通 PNG**，后续再用 WIC/GDI+ 处理（PNG 是可靠的）。
- 验证：同一区域用 Chromium 截图与 `read_image` 预览一致；WIC 直读结果与它不一致。

## 29. `capture-window.ps1` 的 `wait:` 单位是**秒**（R93）

- 现象：`-Steps "click:...;wait:1200"` 想等 1.2 秒，结果脚本卡到超时（>180s），什么都没有输出。
- 根因：步骤里 `wait:` 的参数是秒（`wait:1` = 1 秒），不是毫秒。
- 规避：要 0.3 秒写 `wait:0.3`；长等待最多写 `wait:5`，别把毫秒当秒。
- 验证：`wait:1` 的同一串步骤 15 秒内结束。

## 30. 新增 Tauri 窗口必须写进 `capabilities/default.json`（R94）

- 现象：`tauri.conf.json` 里加了 `pet` 窗口，能显示、位置也对，但里面**一片空白**，
  宠物不渲染、`pet.tick` 也不发生（pet.db 时间戳不动）。没有任何报错、没有日志。
- 根因：`capabilities/default.json` 的 `windows` 只列了 `["main", "desktop-lyrics"]`。
  Tauri 2 的 ACL 按窗口授权，**没登记的窗口所有 plugin 命令都被拒绝**——
  `listen/emit`（core:event）、`setPosition/show/hide/outerSize`（core:window）全静默失败，
  前端里那些调用在 `try/catch` 里被吞掉，于是页面看着「正常但什么都没有」。
- 排查方式：把窗口临时改成 `"transparent": false` + `"backgroundColor": "#FF3366"` 再截图——
  看到纯色方块说明窗口在画、内容没加载/没跑，据此把范围从「渲染」缩到「权限」。
- 规避：新窗口一律同时改三处：`tauri.conf.json` 的 `windows`、`capabilities/*.json` 的 `windows`、
  以及它要用的窗口 API 权限（如 `allow-outer-size` / `allow-is-visible`）。
- 验证：`release/screenshots/r94-pet-window.png`（宠物真的画出来了）。

## 31. 窗口间事件**不排队**，晚起的窗口会漏掉第一次推送（R94）

- 现象：宠物窗口在启动时就创建（`visible: false`），主窗口在挂载时推了一次播放快照，
  但宠物窗口是**另一个 WebView**，等它执行到 `listen` 时那次推送早过期了——
  于是它永远停在「没启用」的默认载荷上，什么都不画。
- 根因：Tauri 的 `emit` 是「此刻有谁在听就给谁」，没有离线队列（与浏览器 CustomEvent 一样）。
- 规避：**握手 + 心跳**。窗口起来后 `emit('gently:pet:ready')`，主窗口收到就补发一次；
  另外每 2s 推一次兜底（桌面歌词同款做法，那边用 1s）。
- 验证：`smoke` 里没有这一条（跨窗口），靠打包版实图 + 「pet.db 时间戳会动」确认。

## 32. 透明窗口用 `PrintWindow` 截图是**全黑**的（R94）

- 现象：想单独截宠物窗口，`PrintWindow(PW_RENDERFULLCONTENT)` 得到一张纯黑 200×200。
- 根因：WebView2 走 DirectComposition，`PrintWindow` 拿不到合成结果；透明窗口更没有可画的背景。
- 规避：截**整屏**（`Graphics.CopyFromScreen`）再裁窗口矩形；或者干脆临时给窗口加不透明背景色再截。
- 验证：整屏截图里能明确看到宠物窗口压在别的应用上面。

## 33. 像素画按非整数比例缩放会出「黑色颗粒」（R95）

- 现象：宠物精灵在 96px 高（格子 208px，比例 0.46）下渲染，头发与翅膀上出现一圈**黑色颗粒/毛边**，
  肉眼看像素材脏；把同一格从 PNG 里 1:1 裁出来放大看却完全干净。
- 根因：浏览器默认对图片做双线性/多相插值。像素画是硬边高频图，非整数比例下深色描边会被采到半个像素上，
  和透明背景混在一起就变成一圈灰黑点。透明区保留的白色 RGB + 半透明混合会加重这个现象。
- 规避：**整数倍缩放 + 关掉插值**：显示高度取格子高的整数分之一（内置是 104px = 208/2）；
  `.body.sprite` 上 `image-rendering: pixelated`；背景偏移与 `background-size` 全部 `Math.round` 取整
  （落在半像素上还会再触发一次重采样）。
- 验证：`pnpm smoke` 的「按整数倍缩放 / 偏移取整」两条；`release/screenshots/r94-pet-window.png` 放大后无颗粒。

## 34. 截图脚本点不到控件时：先把窗口设成 TOPMOST（R97）

- 现象：`SetForegroundWindow` + 窗口内坐标点击，控件毫无反应（`capture-window.ps1` 会警告
  「没能把窗口抢回前台」）；同一脚本早先能用。
- 根因：前台被别的应用（浏览器）占着，Windows 只允许「前台进程」抢焦点；`SetForegroundWindow`
  对非前台进程是「请求」而不是「命令」，被静默忽略后点击就落到了上层窗口上。
- 规避：点击前 `SetWindowPos(hwnd, HWND_TOPMOST, …, SWP_NOMOVE|SWP_NOSIZE|SWP_SHOWWINDOW)` 把窗口提到最上层，
  截完再 `HWND_NOTOPMOST` 还原；这比 `SetForegroundWindow` 可靠，也不需要动别的应用。
- 验证：同一坐标 `click:1057,27` 能稳定打开设置页（`r97-pet-preview.png`）。
## 35. 「看着鼠标」只能由宿主轮询全局光标（R99）

- 现象：想在宠物里实现「看向鼠标」，但宠物窗口的 `pointermove` 只有在鼠标**进到它自己那 200×160** 时才有；
  鼠标在屏幕别处时前端什么都收不到。
- 根因：光标是**系统级**概念，WebView 只给它所在窗口里的事件；没有跨窗口的全局光标 API。
- 规避：宿主侧每 60ms `GetCursorPos`，用「窗口 `outer_position()` + `inner_size()`」（都是**物理像素**，
  与光标同单位）算相对窗口中心的角度，量化成 16 向（0 = 正上、顺时针），**只有变化时**才
  `emit_to("pet", "gently:pet:look", dir)`；核心只做规范与透传（`pet.tick` 的 `look_dir` → `frame.look`），
  挑哪一格交给渲染层（且只在待机时用 look 格，否则奔跑中会像卡住）。
- 验证：`GENTLY_LOG=debug` 启动后把光标分别放到宠物上方/右侧/左侧/下方，日志依次出现
  `dir=0 / 4 / 12 / 8`；`cargo test -p pet-core --test look` 3 项锁方向规范化与两行校验。
## 36. 自动点击穿透要按缩放因子折算坐标（R100）

- 现象：想让宠物窗口「只有精灵本体吃点击」，宿主拿光标位置和精灵矩形比，结果在高 DPI 屏幕上判定偏移了半个宠物。
- 根因：光标（`GetCursorPos`）与窗口位置/尺寸是**物理像素**，而前端量出来的 `getBoundingClientRect()` 是 **CSS 像素**；
  150% 缩放下两者差 1.5 倍。
- 规避：宿主侧用 `window.scale_factor()` 把精灵矩形折成物理像素再比；窗口大小同样取 `inner_size()`（物理）。
  另外要**先设一个保守默认**（还没收到矩形时当作整窗都是精灵），否则事件晚到时宠物会短暂点不到。
- 验证：`cargo test -p gently` 里有 `hit_box_respects_the_scale_factor`（1.0 / 1.5 两档 + 边界）；
  打包版日志在光标移到精灵外时打出 `ignore=true inside=false`，回到精灵上打 `ignore=false inside=true`。
## 37. 自动点击穿透必须覆盖**每一块**可交互区域（R102，拖动失效的根因）

- 现象：宠物窗口的拖动条「完全拖不动」，点宠物本体也拖不动；窗口像块玻璃。
- 根因：R100 的自动穿透只把**精灵本体**登记成可交互区域，顶部那条拖动条不在里面 →
  宿主把整窗设成 `ignore_cursor_events(true)` → 拖动条永远收不到 `pointerdown`，
  `data-tauri-drag-region` 与 `startDragging()` 都不会被触发。
- 规避：可交互区域改成**多块矩形列表**（`src/pet/hit-areas.ts` 统一登记与去重上报），
  宿主 `inside_any` 任意一块命中就不穿透；宠物本体加了「按住移动 > 5px 才开始拖」，拖完那一次 `click` 吞掉。
  **R103 起去掉了那条拖动条**：它离宠物很远，拖起来像在拖一个看不见的窗口（用户反馈「反直觉」）——
  现在窗口里唯一可交互的只有宠物本体，透明区域一律穿透。
- 验证：日志里 `宠物可交互区域已更新 count=1`（只剩宠物本体）；光标放到宠物身上 → `inside=true`；
  光标放到窗口左下空白 → `inside=false`。**注意**：注入式鼠标事件（`mouse_event` / `SendInput`）
  驱动不了窗口拖动（连主窗口标题栏都拖不动），所以「拖一下窗口真的跟着走」只能人工确认。

## 38. 「程序摆放窗口」会被当成用户拖动，污染位置记忆（R102）

- 现象：宠物偶尔出现在主窗口旁边的奇怪位置，而不是右下角或上次拖到的地方。
- 根因：宠物窗口在创建时会先出现在系统给的默认位置，`onMoved` 立刻把它写进
  `gently:pet-window-pos`；等 `placePetWindow` 再摆到右下角时，记忆里已经是那个默认位置了。
- 规避：摆放之后立刻把「这次是程序摆的」记进 `gently:pet-window-placed`；
  宠物窗口收到 `onMoved` 时，位置与它相差 ≤2px 就**不写**记忆。
- 验证：重启后宠物稳定出现在上次记住的位置（或右下角），不再随机贴到主窗口边上。

## 39. 拖动期间宿主必须停手：穿透切换会当场掐断拖动（R104）

- 现象：按住宠物本体拖动，窗口跟着走一两帧就「卡住」，松手后宠物也不响应了（要点两次才活）。
- 根因：宿主 60ms 轮询按**光标是否在精灵矩形内**决定穿透。系统窗口拖动时窗口位置更新滞后于光标，
  快速拖动的那几十毫秒里光标已经出了矩形 → `set_ignore_cursor_events(true)` →
  下一次 `pointermove` 根本到不了 webview，拖动断在中间。
- 规避：前端判定「开始拖」时先发 `gently:pet:dragging {dragging:true}`，
  `startDragging()` 返回后（或窗口失焦）发 `false`；宿主在 `DRAGGING` 为真期间
  **既不切穿透、也不自己走动**（`poll_once` 里直接 return）。
- 验证：日志里拖动期间没有 `宠物窗口点击穿透状态切换`；拖完能立刻再点（不用点第二次）。

## 40. `pnpm ui:capture` 跑的是 `release/` 里的**打包版 exe**（R104）

- 现象：改完代码、`pnpm tauri build --no-bundle` 成功、截图却还是旧界面（新手写进面板的行没有），
  一度以为「自动探测没生效」，其实截的是上一轮的包。
- 根因：`scripts/capture-window.ps1` 的默认 `-Exe` 是
  `release\gently-0.1.0-windows-x64\gently.exe`，而 `tauri build` 只更新 `src-tauri/target/release/`。
- 规避：**改完代码要截图，先 `pnpm package:portable`**（或显式传 `-Exe src-tauri\target\release\gently.exe`），
  再跑 `pnpm ui:capture`。看截图上某行文案是不是新版，比看时间戳更可靠。
- 顺带记一笔：截图上的坐标是**物理像素**（1280×800 对应 1011×632 的 CSS 预览，约 1.266×），
  按预览图量出来的坐标要乘回去（§33）。

## 41. 本机回调端口的测试要在 connect 上重试（R104）

- 现象：`cargo test -p gently-core --test oauth` 偶发失败（`连接本机回调端口` panic），单独跑又必过。
- 根因：回调监听是 `auth.begin` 里新起的线程，绑端口是异步的；`begin` 返回后立刻 `connect`，
  机器忙（verify 里同时在编译别的 crate）时端口还没在监听。
- 规避：测试统一走 `connect_callback()`（最多重试 3 秒）；**不要**用「`sleep` 固定毫秒再连」，
  那只是把抖动换成更长的等待。

## 42. 素材各行角色比例不一致：用 `fit` 归一，别改图（R105）

- 现象：待机 → 跑/跳 时宠物**突然变大**（内置素材的「跑」
  那一行比「待机」高 19%，「失败/等待」两行是头部特写、头比别人大 20%）。
- 根因：素材是分几批画的（或 AI 生成），同一张图集里各行角色的实际比例不一致；
  渲染层按「整格等高」画，比例差就直接表现成大小跳变。
- 规避：`pet.json` 的 `animations[].fit{scale,offsetX,offsetY}`（见 `docs/pet-package.md` §3.1）：
  **整行**等比缩放 + 底部对齐，盒子取所有行里最大的那一格（放大也不裁切）。
  内置包实测取值 0.8–1.08。`lookRows` 不受 `fit` 影响（同一张脸不能被缩放）。
- 另两个必须记住的点：
  1. 背景必须挂在**格子大小**的图层上（`.spriteLayer`），盒子比格子大时
     直接在有背景的盒子上画会**露出图集里相邻格子**的像素（实测右侧多出半个身子）；
  2. 盒子要 `overflow: hidden`，否则放大后的那一行会把邻居一起画出来。

## 43. 拖动必须自己搬窗口，不能用 `startDragging()`（R105）

- 现象：拖宠物像在拖一个看不见的窗口边框；拖动过程中**没法播动画**（想加「被拎起来」的动作也没处放）。
- 根因：`getCurrentWindow().startDragging()` 是**系统级**拖动（`WM_NCLBUTTONDOWN` + `HTCAPTION`），
  它把事件循环交出去直到松手——JS 在这期间不跑，画面就是冻的。
- 规避：按下时记住「屏幕坐标 + 窗口位置」，`pointermove` 里自己算新位置并用
  `setPosition(PhysicalPosition)` 挪窗口（`requestAnimationFrame` 合并，一帧最多一次 IPC）。
  这样 JS 一直在跑：拖动时可以演「被拎起来」的动画（这里用 `jump` 那一行）。
  位置要按**屏幕坐标差 × devicePixelRatio** 算，不能用「当前窗口位置 + 增量」（IPC 异步，会累积漂移）。
- 顺带解决的老问题：拖动期间要告诉宿主「我在拖」（`gently:pet:dragging`），
  宿主据此不切点击穿透、也不自己走动。

## 44. 改完协议「注入式鼠标事件拖不动窗口」的结论不再成立（R105）

- R102 的结论是「注入式输入驱动不了窗口拖动，只能人工确认」——那是**系统拖动**时代的事实。
- 现在拖动是 JS 自己挪窗口，`mouse_event` + `SetCursorPos` 能完整驱动它：
  实测指针走 (-120,-72)、窗口跟 (-120,-72)，1:1 跟手。自动化验收因此**可以**覆盖拖动（见 `docs/pet.md` §3）。
- 但有两个坑必须避开：
  1. PowerShell 默认 **DPI 未感知**：枚举出来的窗口矩形是虚拟化的（1.25 倍下差 20%），
     按它算出来的坐标点不到宠物本体（表现为「拖了没反应」）——
     脚本开头先 `SetProcessDpiAwarenessContext(-4)`；
  2. 宠物窗口可能正好**落在主窗口后面**，注入的点击会打到主窗口上：
     先用 `SetWindowPos` + `BringWindowToTop` 把它摆到可见位置再操作。

## 45. 动画切换要有确认期，否则会「闪一下」（R105）

- 现象：走动过程中动画「跑 → 待机 → 跑」闪一帧。
- 根因：走动方向是宿主每 60ms 报一次的值，光标擦过宠物、窗口被挪动都会让某一拍报回 0；
  核心拿到 0 就立刻切 `idle`，下一拍照旧切回 `run`。另外行为表有冷却，
  「靠重复触发来计时」不可靠（第二次触发可能被冷却挡掉）。
- 规避：状态类动画每拍**独立**算一次「应该是什么」（忽略行为冷却），
  同一个目标连续满 `SWITCH_DELAY_MS = 160ms` 才切；`play` 带 `"interrupt": true`
  的（点击、换歌）当拍就切。宿主侧另加迟滞：光标连续 10 拍（≈0.6s）都在宠物身上才暂停走动。
- 验证：`pet-core/tests/transition.rs`（单拍抖动不切、持续状态按确认期切、抖动不重置确认期、
  `interrupt` 当拍生效）。

## 46. 「声明了但不生效」的字段比没有字段更坏（R106）

- 现象：宠物包的 `minPetCoreVersion` 写了也不影响安装；`Condition::SilentFor{ms}` 实现成
  「没在播就算」——`ms` 形同虚设。
- 根因：两处都是「先把字段接进来、语义留到以后」的典型半成品：文档写着能力，代码里没有对应行为。
- 规避/教训：**要么真做，要么在文档里写「暂不生效」**。这一轮把它们做成真的：
  - 版本：`version` 必须能解析（`x.y.z`），`minPetCoreVersion` 与本机核心比较，高于核心 →
    新错误码 `pet.incompatible`（界面有本地化文案，不再把中文开发者说明直接甩给用户）；
  - 静默：只有「没在播」的时间才累计，恢复播放立刻归零；
  - 体积：`pet.json` 原文 512 KiB、图集 8 MiB，都在落库之前检查。
- 验证：`pet-core/tests/version.rs`（6 项）、`pet-core/tests/silence.rs`（3 项）。

## 47. 打断型动画必须「演完一遍」，否则等于没反应（R106）

- 现象：点了宠物（`jump`）或换歌（`inspect`），画面只抖一下又回到待机。
- 根因：R105 的「160ms 确认期」对**所有**切换生效——包括刚被 `interrupt` 切过去的反应动作。
  下一拍状态机算出「现在是待机」，160ms 后就把反应动作覆盖了。
- 规避：`interrupt` 切换时记下「至少演到什么时候」（`frames × frameMs`，夹在 200–2000ms），
  这段时间里状态机不接管画面。状态类动画仍然走 160ms 确认期，两者互不干扰。
- 验证：`pet-core/tests/silence.rs` 里的 `zero_milliseconds_...`（当拍切换）+
  `pet-core/tests/transition.rs` 的 `interrupt_actions_switch_on_the_same_tick`。

## 48. `rquickjs-sys 0.7` 没有 Android 的 FFI 绑定：编译直接失败，且只给一条 warning（R107）

- 现象：`cargo build --target aarch64-linux-android -p gently-core` 报
  `error: couldn't read .../rquickjs-sys-0.7.0/src/bindings/aarch64-linux-android.rs`。
- 根因：该 crate 的 `src/lib.rs` 在**没开 `bindgen` feature** 时执行
  `include!(concat!("bindings/", bindings_env!("TARGET"), ".rs"))`，而 `src/bindings/` 只带 10 个 target
  （有 `aarch64-unknown-linux-gnu`、没有 `aarch64-linux-android`）。`build.rs` 对此只打一条
  `cargo:warning=rquickjs probably doesn't ship bindings for platform ...`，不中断构建，所以很容易被当成噪音略过。
- 规避：三选一（[`ANDROID-PLAN.md`](ANDROID-PLAN.md) §3.1）——复制绑定走 `[patch.crates-io]` /
  只在 android target 开 `bindgen` feature（需 `libclang` + 联网拉 `bindgen`）/ 升级 `rquickjs`。
  **不要**直接改 registry 缓存里的 crate 源码：换机器/换人就不复现。
- 验证：`pwsh -File scripts/android-env.ps1` 的「QuickJS 绑定」一行（查 `src/bindings/` 里有没有那个文件）。
- 现状（2026-11-01）：已按「复制绑定」落地——`vendor/rquickjs-sys/` + 根 `Cargo.toml` 的
  `[patch.crates-io]`，来路与撤销方式见 `vendor/rquickjs-sys/VENDORED.md`；
  桌面端用 `cargo test -p gently-core` 验过，Android 侧要等 P0-8（真机跑一次插件沙箱）才算 ABI 正确。

## 49. 受限会话里「命令没输出 / HTTPS 全失败」不等于环境坏了（R107）

- 现象：被沙箱代理的 pwsh 会话里，`rustup target list`、`java -version` 的**输出捕获**直接失败
  （`StandardErrorEncoding is only supported when standard error is redirected` / `拒绝访问`），
  所有 HTTPS 请求失败（`curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`），
  于是很容易误判成「工具没装」「网络不通」。
- 根因：沙箱禁止 piped stdio（拿不到子进程 stdout/stderr）与凭据/TLS 访问——是**会话限制**，不是机器状态。
- 规避：① 必须捕获时用 `Start-Process -RedirectStandardOutput <文件>`（本机实测可用）；
  ② 判断「装没装」优先看文件/目录事实（`toolchains/<tc>/lib/rustlib/<triple>`、`$NDK_HOME\...\llvm-ar.exe`），
  别只信命令输出；③ 网络只信 TCP 连通性与 `web_fetch`，逐端点 HTTP 码留给普通终端复测。
- 验证：`scripts/android-env.ps1` 把这两类降级成 WAIT（而不是 MISS），避免把会话限制报成环境缺失。

## 50. 移动端只有一个 webview：多窗口配置会让它加载「最后一个」窗口 → 整屏白（R107）

- 现象：安卓端 APK 装好、进程活着、核心日志一切正常（8 条迁移、数据库就绪、宠物就绪），但屏幕**全白**。
- 根因：`tauri.conf.json` 有三个窗口（`main` / `desktop-lyrics` / `pet`），移动端只起一个 webview，
  实测加载的是**最后一项** `index.html?window=pet` → `main.tsx` 走 `PetWindowApp` 分支，
  没有宠物时什么都不画。ACL 没报错、日志没报错，所以极具误导性。
- 规避：给移动端单独一份 `src-tauri/tauri.android.conf.json`，`app.windows` **只留 `main`**（数组整体替换）。
  验证口径：解包 APK 看 `assets/tauri.conf.json` 的 `windows` 是否只剩一项；`scripts/android-env.ps1`
  的「移动端单窗配置」一行会直接判。
- 附带症状：白屏期间 logcat 里 `Tauri/Console` 会刷 `Couldn't find callback id …`（宠物页在轮询），
  看到这串说明**加载的确实是 pet 页**。

## 51. `tauri android dev` 的包不含前端资源：离开 dev server 就是白屏（R107）

- 现象：把 dev 流程装上的 APK 留在手机上，隔一会儿再打开 → 白屏；但核心日志照常写。
- 根因：dev 包只带 `assets/tauri.conf.json`（解包可见 `assets/` 下就这一个文件），页面从
  `devUrl`（实测是宿主 LAN IP，如 `http://192.168.x.x:1420/`）加载；dev server 不在就没内容。
- 规避：**验收 UI 用 `pnpm tauri android build --debug -t aarch64 --apk`**（自带 `dist/`），
  `dev` 只用于热更新开发。另注：`dev` 的 `beforeDevCommand` 独占 1420，上一轮 vite 没退就会
  `Port 1420 is already in use`。

## 52. 安卓取证两件小事：熄屏会截出纯白图；数据目录不是 `files/`（R107）

- `adb exec-out screencap -p` 在设备熄屏时不会报错，只会给你一张**纯白图**（10 KB 左右）。
  取证前先 `adb shell svc power stayon true` + `input keyevent KEYCODE_WAKEUP`，截完再
  `svc power stayon false` 还原。判断是否熄屏：`dumpsys power` 里的 `mWakefulness=` / `Display Power: state=`。
- 应用数据目录是 **`/data/user/0/com.xun.gently`**（`gently.db`、`logs/`、`pet/`、`plugins/`…），
  不是 `/data/data/…/files/`（那里只有 `profileInstalled`）。`adb shell run-as com.xun.gently cat logs/gently.log.<日期>`。
- 另外「数据目录：…（来源 …）」那行是 `eprintln!`（日志初始化之前），**只进 logcat、不进日志文件**；
  拿它当验收项会永远搜不到。

## 53. 手机列表不能「把桌面列压窄」：要么两行式，要么横向溢出（R109）

- 现象：搜索/本地等表格在真机竖屏（约 360 CSS px）下右侧被裁——标题列被挤成省略号，
  「大小 / 操作」两列直接看不见（`r108-android-search.png` 是证据）。
- 根因：`table.config.tsx` 的列宽下限是按**桌面最小窗口 900 宽、内容区约 612** 算的
  （文件头那段账）。手机上没有 612，于是 grid 各列按自己的 `minmax` 下限硬撑 → 溢出。
- 规避（R109 已落地）：手机上**换一份列定义**（`mobileTrackColumns` / `mobileColumns`）：
  `主信息(1fr) + 时长 + ⋯`，两行式（标题 / 歌手·专辑·音源），行内那排小按钮收进
  `⋯ → 底部操作面板`（`components/ui/row-actions`）。由 `DataTable` 按 `useShellMode()` 选，
  **视图里不写 `@media`**，也不要在视图里 `useViewport()`。
- 附带两条口径：① 桌面列定义不许为了手机改宽度（`smoke` 有一条断言钉住桌面 7 列的 key 序列）；
  ② 空表头在手机上隐藏（`data-layout="mobile"`），否则顶上一条只有「标题」的表头看着像坏掉。

## 54. 想用 `position: fixed` 盖住整屏的浮层，别放进带 `backdrop-filter` 的容器里（R109）

- 现象（本轮踩到）：手机上的底部操作面板如果从表格行里 `position: fixed`，会被
  `DataTable.container` / `MobileShell.shell` 的 `backdrop-filter` 吃掉——那两个属性
  **会为 fixed/absolute 后代建立包含块**，`inset: 0` 于是只覆盖表格/外壳自己，
  面板出现在页面中间而不是屏幕底部。
- 规避：面板的**宿主放在外壳外面一层**（`MobileShell` 里的 `<RowActionsProvider>` 包住 shell，
  面板渲染成 shell 的兄弟节点），`position: absolute; inset: 0` 落到 `.app__content`
  （`position: relative`，整屏）。同理：桌面歌词/宠物的窗口浮层不要塞进滚动容器。




## 55. 别拿「铺满屏幕的 `<button>`」当遮罩：真机上它既不涂背景、也收不到点击（R109）

- 现象：底部操作面板 / 导航抽屉的遮罩在浏览器预览里正常（浅色方案下也压暗），
  **装到真机（Android 10）后完全看不见**——面板像浮在半空，列表一点没暗；
  把遮罩色挪走后更暴露了第二半问题：**点面板外的空白也关不掉**（点遮罩的 `onClick` 不触发）。
  像素实测：`#FFFFFF` → `#FFFFFF`（浏览器里同一份 CSS 是 `#1E1E1E` → `#101010`）。
- 定位过程（省下次别重走）：token 有、CSS 有（`dist` 里能 grep 到 `--modal-scrim`）、
  `inset: 0` 在该 WebView 上是支持的（抽屉定位正常）。把同一个 `background: var(--modal-scrim)`
  从 `<button>` 挪到它的**父 `<div>`** 上，立刻生效——问题在「button + 全屏 + 不涂色」这一组合。
- 规避（两条都要）：① **遮罩色永远画在容器 `<div>` 上**，`<button>` 只当额外的 a11y 取消入口；
  ② **关闭动作挂在根 `<div>` 的 `onClick` 上**（面板自己 `stopPropagation`），再给一个显式的 ✕。
  `ConfirmDialog` 一直是「div 遮罩 + 按钮在弹窗里」的结构，所以它的压暗与取消在真机都正常。
  这条同时解释了「同一份 CSS 在浏览器对、真机不对」——别先怀疑主题 token。





## 56. 「播不出声」先看代理回了什么：上游常用 **HTTP 200 + HTML 错误页** 冒充媒体（R110）

- 现象：真机点播放 → 播放条出现、进度在走，但没声音；logcat 里是
  `DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed` +
  `MEDIA_ELEMENT_ERROR: Network error`。R108/R109 一直把它当「解码 / Content-Type 问题」查，
  换了类型、加了嗅探都没用——因为**根本不是解码问题**。
- 真凶（一行日志定位）：代理把上游响应记下来之后是
  `媒体响应 status=200 content_type="text/html;charset=utf8" sniffed="(unknown)"`。
  把那段 HTML 取出来读，是**网易云的「网页找不到」页**（10 万字节、HTTP 200）。
  也就是说：插件给的媒体地址早就不服务音频了（登录态/防盗链/过期），而 CDN 用 200 + 错误页回应。
- 关键教训：
  1. **状态码不等于内容**。上游 200 不代表拿到音频，必须按字节/类型判一次；
  2. **代理层的日志要能回答「回了什么」**（status / content-type / 嗅探结果 / 前缀长度），
     只有「收到一个 GET」这种日志会把排查引向错误的层（R109 就在这里白花了一轮）；
  3. 媒体元素只会给你 `MediaError.code = 4`，**拿不到服务端原因**——所以判断必须在核心做。
- 现在的行为（R110 起）：代理嗅探首字节决定 `Content-Type`（fMP4 / ID3 / fLaC / OggS / RIFF-WAVE /
  ADTS / webm），认出不是音频就记一条 WARN「上游返回的不是可识别的音频（多半是错误页 / 需要登录 /
  需要请求头）」。**别再用「换个 Content-Type 试试」对待这类故障。**
- 取证口径（判断 App 侧通不通，与源无关）：把一段音频 push 进应用私有目录
  （`adb push` → `run-as com.gently cp music/`），在「本地音乐 → 扫描本地目录」里扫它，
  点播放后看 `媒体响应（本地文件） status=206`，再用 `scripts/android-cdp.mjs eval` 读
  `[role=slider]` 的 `aria-valuenow/aria-valuemax`（实测 38/271 → 44/271，说明真的在播）。

## 57. 安卓上 `play()` 可能**既不成功也不报错**：谁 await 它谁永久卡住（R111）

- 现象：手机熄屏放歌，约 2.8 分钟后声音停了；解锁回前台，界面**一直显示「播放中」但进度不动**，
  点什么都不动（只能杀进程重来）。进程没死（`pidof` 一直在），`ActivityRecord` 也在栈顶。
- 根因：媒体管道被系统掐掉之后，`HTMLMediaElement.play()` 返回的 Promise **既不 resolve 也不 reject**。
  一个 `await new Audio(url).play()` 的探针挂到 CDP 超时都没回来，而旧的恢复逻辑正是
  `await el.play()` → 永远不往下走 → 看门狗拿不到结论 → 没有重载、没有换源、没有停表。
- 规避（R111 已落地）：**任何 `play()` 都要带超时**（`audio.service.ts` 的 `tryPlay()`，3 秒，
  三种结局 `ok / rejected / timeout`）。超时**不能**当「这个源坏了」——那会白换一轮源；
  应该：先重载一次 → 仍不行就让 store 重新解析一次 → 还不行就 `markInterrupted` 如实停表
  （文案「播放被系统中断（点播放继续）」，点播放走 `retryPlayback`）。
- 顺带记下测量结论（P2 入口条件）：**熄屏后音频还能正常播约 2.8 分钟**，之后停住；
  真机前台服务（foreground service）+ MediaSession 是 P2 的正解（详见 `ANDROID-PLAN.md` §7.4）。
- 排查口径：判断「是不是真的在播」别信界面，用 `node scripts/android-cdp.mjs eval` 读
  `[role=slider]` 的 `aria-valuenow`；连着两次一样就是没在播。

## 58. 安卓原生代码住在 `gen/android`，且「保活」必须靠前台服务（R112）

- **不要以为 `src-tauri/gen/android/` 是「生成目录、碰不得」**：Tauri CLI 只在缺失时生成它，
  之后它就是工程的一部分。自定义 Service / Plugin / 清单权限都加在这里（本项目 R112 就是这么做的：
  `PlaybackService.kt` + `PlaybackPlugin.kt` + 清单里的 `<service>` 与三条权限）。改了要连带
  `pnpm tauri android build --debug -t aarch64 --apk` 真机验一次——**它不进 `pnpm verify`**。
- **Rust ↔ Kotlin 只有「命令」一个方向**：`tauri::plugin::Builder::new(名字).setup(|_, api| api
  .register_android_plugin("com.xun.gently", "PlaybackPlugin"))` 注册，之后用
  `PluginHandle::run_mobile_plugin("update", payload)` 调 Kotlin 的 `@Command`；
  Kotlin 侧 `@TauriPlugin class X(activity: Activity) : Plugin(activity)`，参数类标 `@InvokeArg`。
  **Kotlin 主动通知前端**得靠 `Plugin.trigger` + 前端 `Channel`，别指望 `emit` 一个系统事件。
- **`targetSdk = 36` 的前台服务有两道硬门槛**：清单里必须有
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK` 权限与 `<service android:foregroundServiceType="mediaPlayback">`，
  否则 API 34+ 直接 `SecurityException`；`startForegroundService` 之后 **5 秒内**必须
  `startForeground(id, notification)`。API 33+ 还要 `POST_NOTIFICATIONS` 才能看见通知
  （不影响保活，只是通知不显示）。
- **效果怎么验**（别只看界面）：`adb shell dumpsys activity services com.xun.gently` 要看到
  `isForeground=true foregroundId=…`；再用「熄屏 4 分钟之后读 `aria-valuenow`」对比——
  没有前台服务时 R111 实测停在 171/226 或整页重载，加了服务后同一测量是 5 → 258（+253 秒）。

## 59. 手机上的 store 会被「整页重载」清空：播放状态必须落盘（R113）

- 现象：安卓把 WebView 的渲染进程回收之后，页面会重新加载——内存里的 store 全部归零，
  用户切回来看到的是**空播放条**（R111 实测的第三种形态；`pidof` 没变，所以别以为是进程死了）。
- 规避（R113）：`utils/lastPlayback.ts` 把「上次在放什么 + 放到哪」写进 `localStorage`
  （`gently:last-playback`），启动时恢复成**暂停态**。三条容易写错的地方：
  1. **恢复必须暂停**：自动出声既违反自动播放策略，也不是用户要的；
  2. **恢复出来的状态没有 `audioUrl`**：所以 `toggle()` 必须区分「有地址的暂停」与「没地址的暂停」，
     后者要先 `recoverPlayback()`（重新解析、保留进度），否则界面翻成「在播」却没有声音；
  3. **写盘要节流**：位置每秒都在变，`setProgress` 里只在 10 秒间隔落一次盘，
     换歌/暂停用 `force` 立刻写，`stop()` 清掉（用户主动关掉的歌不该下次自己冒出来）。
- 别把队列一起持久化：队列可能上千条、来自随时会变的源；恢复一首歌 + 位置就够用。
- **恢复后点播放会从 0 开始**（真机踩到两次，两个不同原因，缺一不可）：
  1. 恢复出来的曲目**没有候选音源**（`candidates: []`）→ `recoverPlayback` 一上来就判「都没解析到」，
     于是「恢复了一首歌却点不动」。恢复时要用 `candidatesOf(track)` 补一条候选；
  2. `audio.service.seek()` 曾经在 `this.el` 为 null 时直接 return——而恢复的调用顺序是
     **先 seek 再 load**（引擎这时还是新的、没有元素），定位被丢掉，用户点了就从 0 播。
     现在 `seek()` 走 `ensure()`，定位挂到 `loadedmetadata` 上。
     真机复测：`150/271` → 冷启动 `restored=150` → 点播放 `156/271`（接着放）。

## 60. 前台服务的「active」不等于「playing」：一暂停就把通知和 MediaSession 一起关了（R115）

- 现象：通知栏的 ⏸ 按下去能暂停，但**之后再按 ⏯ / 耳机键就没反应了**——通知消失，
  `dumpsys media_session` 里也没有我们的会话了。
- 根因：前端把两个概念当成一个值传下去（`syncPlaybackBanner(playing, …)`），于是
  暂停 = `active=false` → Kotlin `stopService()` → 前台服务退出 → `MediaSession.release()`。
- 规避：**`active` = 有没有当前曲目**（决定服务起不起），**`playing` = 在不在播**
  （只决定按钮图标与 `PlaybackState`）。暂停时服务必须留着，否则锁屏 / 耳机键那条路就断了。
  真机判据：暂停后 `dumpsys media_session` 仍要有
  `Media button session is com.xun.gently/gently-playback` 且 `state=PlaybackState {state=2 …}`
  （2 = PAUSED，3 = PLAYING）。
- 传输动作怎么回到页面（P2-2 的取舍）：**原生不拥有播放状态**。Kotlin 在 `Plugin.load(webView)`
  里留下 WebView 引用；用户按按钮 → 服务 `evaluateJavascript("window.__gentlyMediaAction('toggle')")`
  → 前端翻成 store 的 `toggle/next/prev`。为什么不走 Tauri 的插件事件：那条通道是
  「JS 先订阅、Rust 转发」的单向管道，而「用户按了通知按钮」是**原生主动发起**的；
  注入一行调用是最短的一条路（Tauri 自己装 `__TAURI_INTERNALS__` 也是同款做法）。
- MediaSession 用 **framework 的 `android.media.session`**（API 21+）+ `Notification.MediaStyle`，
  不引 `androidx.media`：这台机器离线，少一个 Gradle 依赖就少一条版本坑。
- 真机验证口径（不用点通知栏，直接发媒体键）：`adb shell input keyevent 127`（暂停）/`126`（播放）/
  `87`（下一首）/`88`（上一首），再读页面里 `[role=slider]` 的 `aria-valuenow` 对照。

## 61. 通知栏歌词：只在页面算一行，别把时间轴搬进原生；连同两个会把人带偏的取证细节（R116）

- 分工：**歌词行由页面算**（`currentLyricLine(lines, elapsed)`，没命中就空串），一行文字作为
  `playback_banner` 的第 5 个参数下去；Kotlin 侧只做展示——`setContentText(if (line.isNotBlank()) line else artist)`
  加 `MediaMetadata` 的 `METADATA_KEY_DISPLAY_SUBTITLE`。原生不存时间轴、不存歌词，
  否则「播到哪」就有两处真相（与 §60 同一条原则）。
- 推送频率靠**去重键**管：`playbackBannerKey()` 把 `line` 也算进去，所以只有**换行**才推一次；
  播放进度那种每 250ms 的更新绝不能直接打到原生（跨进程 IPC + 重建通知，发热且闪）。
- 坑 1：`dumpsys media_session` 里 `metadata: size=3, description=标题, 歌手, null` —— **第三项是 ALBUM**，
  不是我们写的 `DISPLAY_SUBTITLE`，它恒为 null。拿它判断「字幕没生效」会白查一圈，
  真正的判据是通知面板的实体截图 + `size=`（三个 key 都在）。
- 坑 2：`node scripts/android-cdp.mjs shot` 走 `Page.captureScreenshot`，只有 **WebView 画面**——
  通知面板、锁屏、状态栏都不在里面。系统界面必须 `adb exec-out screencap -p > x.png`。
  （`cmd statusbar expand-notifications` 之后也要等 1~2 秒再截，太快会截到还没展开的界面。）

## 62. 给通知/锁屏喂「进度」的两个硬条件：时长是异步到的、位置跳变要算跳变（R117）

- **时长是异步到手的事实**，不是一开始就有的：曲目铺上界面时 `duration` 常常是 0（列表里显示 `0:00`），
  要等媒体元素 `loadedmetadata` 才回写。所以「同步通知」那个 effect 必须把 `duration` 放进依赖——
  只依赖「换歌 / 播放暂停 / 换歌词行」的话，原生侧会一直停在「时长未知 → 不画进度条」。
  真机上表现为：`dumpsys media_session` 里 `metadata: size=3`（没有 `METADATA_KEY_DURATION`）、
  `position=-1`，看起来像「代码没跑」，其实跑过了、只是拿的是 0。
- **位置会自己跳**，而且不止「用户拖了进度」这一种：恢复上次的曲目时，媒体元素先报一次 `0`、
  再跳到续播点（`seek(231)`）。只把「用户 seek」当信号的话，原生侧会一直停在 0 差一大截，
  直到下一次暂停/换歌才自愈。所以 `setProgress` 里也要判**大跨度跳变**（> 2 秒就算），
  正常 250ms～1s 的小步不算——`seekSeq` 因此是「位置跳变计数」，不只是「用户拖了一次」。
- 三处必须一致，否则进度条会骗人：`position` 用页面给的快照、`speed` 播放时 1f **暂停时必须 0f**
  （否则系统会自己把进度往前推）、时长未知时 `position` 给 `PLAYBACK_POSITION_UNKNOWN(-1)`
  （给 0 会让锁屏显示「0:00 / 0:00」）。
- 本机 ROM（EMUI 10 / Android 10）的通知、控制中心媒体卡、锁屏媒体卡**都不画进度条**：
  数据对了也看不见，判据只能读 `dumpsys media_session` 的 `state=PlaybackState {… position=…}`。
  别为了「看得见」去声明 `ACTION_SEEK_TO`——它会让某些 ROM 画出**能拖但拖不动**的进度条（§46）。

## 63. SAF 的类型过滤会把「系统不认识的音频封装」灰掉；而且 `audio/*` 写进块注释会当场闭合注释（R118）

- 现象：`ACTION_OPEN_DOCUMENT` + `type="audio/*"` 时，`.m4s`（B 站下载的音频，本质是 ISO-MP4/AAC）
  在选择器里是**灰的**，根本点不了；同一个文件改名 `.mp3` 就能选。
- 判据（一分钟确诊）：把同一个文件复制成两个扩展名推到 `/sdcard/Download`，看选择器里哪个可选——
  灰掉的那个就是系统 MIME 库不认的。真机实测：`.m4s` 灰、`.mp3` 可选。
- 规避：放开过滤（`type="*/*"` + `EXTRA_MIME_TYPES=["audio/*","application/octet-stream"]`，
  未知封装会落在 `application/octet-stream` 里因此可选），**自己按扩展名筛**，并且
  - 名单要与**核心**一致（`core/src/local_library.rs::AUDIO_EXTENSIONS` 与 Kotlin 的 `AUDIO_EXTENSIONS`
    各一份，加一种要同时改），否则「选得了却拷不进来」或「拷进来却入库不了」；
  - 跳过的非音频文件**必须报数**（`skipped`）：静默丢弃会让用户以为导入坏了。
- 顺带一个编译坑：Kotlin 块注释里出现 `audio/*` 会**提前闭合注释**（`*/` 就是闭合符），
  报 `Expecting an element` / `Expecting '"'`，而报错行是下一行的 `type = "*/*"`——看着像引号问题，
  其实注释里少了空格。写注释时避免 `*/` 序列（写成「音频类型」或 `audio *`）。

## 64. 「点了没反应」先看 `elementFromPoint`：扩大的触屏热区会抢走相邻控件的点击（R120）

- 现象：真机上点播放条左侧的「打开播放页」**上半截没反应**，点下半截才对。
- 一分钟确诊（真机 CDP，不用猜）：

  ```js
  document.elementFromPoint(158, 858)   // → DIV|进度        ← 被进度条热区挡住了
  document.elementFromPoint(158, 865)   // → BUTTON|打开播放页
  ```

  再对照几何：进度条可见 7px（`y=828..835`），`::before` 热区 32px（`828..860`），
  按钮从 `y=839` 开始——**32px 的热区把按钮的上 21px 吃掉了**。
- 为什么会有这种热区：触屏上「视觉细、命中区不能细」，R109 把进度条热区撑到 32px，
  且刻意**只往播放条内部扩**（往内容区扩会抢列表最后一行的点击）。
- 正解：别在「热区」里争，改在**布局**上给进度线让出一条带——播放条 `padding-top: var(--space-3)`，
  热区改成以进度线为中心（`top: -12px; height: 24px`），正好在按钮行开始处收住。
  代价是最下面 12px 内容区归进度条；换来的是「拖进度」和「点按钮」都成立。
- 反面教材：第一版图省事给按钮行加 `z-index: 3`，结果**整行**（比按钮大，从播放条顶边就开始）
  把热区全盖住，进度条一下都拖不动了——改层级前先量元素盒子，别量按钮。
- 顺带：`position: absolute; inset: 0` 的覆盖层（抽屉）`top: 0` 落在容纳块的 **padding box** 上，
  **不会**继承父级 `padding-top` 的让位——状态栏 30px 的让位要自己再加一遍（R120 抽屉就是这么被时钟压住的）。

## 65. 安卓系统返回要用来「关浮层」；而「每首歌一行」的聚合必须放在核心（R121）

- **返回键 = 关浮层，不是退页**。安卓用户按返回时想关的是抽屉/底部面板。做法：浮层打开时
  `history.pushState({...history.state, gentlyOverlay: true}, '')`（**同 URL**），再听 `popstate`——
  系统返回在 WebView 里就是 `history.back()`，它会先 pop 掉这条标记并触发 `popstate`，我们据此关浮层。
  两个必须做对的细节：① 主动关闭（点空白 / 选了某项）时要把标记 `history.back()` 收掉，
  否则用户的「返回」被白吃一次；② `onClose` 用 ref 存最新值、effect 只依赖 `open`，否则内联回调
  会让 effect 反复重跑、历史里堆一串标记（`hooks/useBackToClose.ts`）。
- **「最近播放」这类视图的聚合放核心**：`play_history` 表是「每次播放一行」（统计要用），
  但界面要的是「每首歌一行」。让界面按 id 去重会同时踩三个坑：React `key` 重复、
  所有同 id 行一起高亮（用户看到的「好几个 a 都是选中态」）、`total` 与分页对不上。
  核心用 `ROW_NUMBER() OVER (PARTITION BY ref ORDER BY played_at DESC, id DESC)` + `COUNT(*) OVER`
  一次给出「最近一次 + 累计次数」，两端都不用再补逻辑。SQLite 3.25+ 才有窗口函数（rusqlite 自带的够新）。
- 手机形态要隐藏的桌面专有项有一份清单（R121 收）：宠物窗口、桌面歌词窗口、网页壁纸助手、
  下载目录/数据目录这类**本机路径**、诊断里的路径与「在文件夹中显示」、发现页相关设置。
  判断一律用 `isMobilePlatform()`（形态），不要用窗口宽度——横屏手机同样是 mobile。

## 66. 背景「加载慢 / 文字糊成一片」的真凶：拿内置演示视频当默认背景 + 全屏毛玻璃（R122）

- 诊断口径：真机上先读 `localStorage['gently:ui'].background`。`asset: null` 且 `kind: 'video'` 时，
  组件会退回**仓库内置的演示视频** `src/assets/bgc.mp4`（100 MB+ 的测试素材）。手机上这就是
  「启动就解码一个大文件」：背景要等 `canplay`，期间表面是主题色，之后整屏切成半透明 + 毛玻璃——
  用户看到的是「背景没适配、加载慢」。
- 第二层：`contentBlurPx` 19px 的 `backdrop-filter` 盖在**会动的视频**上，滚动时文字像被压成一片
  （「字体重叠」）。真机读 `--surface-blur` 就能区分是「透明度」还是「毛玻璃」的锅：
  背景激活时 `--surface-chrome` 会变成 `color-mix(in srgb, var(--bg-surface) 98%, transparent)`。
- 规避：① 手机形态**不使用内置演示视频**（只认用户导入的素材，没素材就不激活背景层）；
  ② 手机默认 `--surface-blur: none`，且内容/抽屉不透明度有 0.92 的下限——文字永远压在自己的底板上；
  ③ 背景层淡入（`layerIn`），「突然出现」本身也算视觉 bug。
- 已解决（R123）：改成 `vite.config.ts` 的虚拟模块 `virtual:gently-bundled-bg`，android 构建直接回 `null`，
  而不是只在运行时不用它——否则安装包与首装时间都被它拖累。





## 67. 左边缘横滑不归应用：手势导航下那一条是**系统返回**（R124）

- 现象：给手机外壳加「左边缘横滑拉出抽屉」后，真机 `adb shell input swipe 5 1200 500 1200 250`
  直接把应用**送回桌面**（`pidof` 里进程没了、焦点回到 launcher），抽屉一次都没打开。
- 原因：本机是手势导航（`settings get secure navigation_mode` = 100），屏幕左边缘的横滑被系统接管成
  「返回」——与我们自己的 pointer 监听无关，应用根本没拿到那一下。SPA 返回到根路由后就是退出应用。
- 结论：**别在系统手势边缘实现应用内抽屉**。要么把触发区挪到边缘之外（>20dp，但那已经不是「边缘滑」），
  要么不做边缘滑、靠工具栏按钮 + 系统返回（返回关浮层的做法见 §65）。
  验收这种手势必须用真机 swipe，注入 `PointerEvent` 测不出来（系统层根本不会转给你）。
- 补充（R125）：与系统不冲突的手势是**底部面板下拉收起**；两件事必须同时做到——阈值别贪大（48px 够），面板上写 `touch-action: none`（否则浏览器/回弹先吃掉 pointermove，真机拖不动）。
- 反面教训：这一版代码在真机上一次都没成功打开抽屉，只在「应用被杀」这一点上留下了痕迹——
  所以「手势类改动」没有真机 swipe 证据就不该进主干。

## 68. 「浮层打开时压住底层按压态」：两条规则都可能白写（R133/R134）

- 症状（用户反馈 #5「动画穿模」）：开抽屉 / 开行操作面板时，底下刚按过的那一层还在跑
  `:active` 高亮的**回退过渡**，透过半透明遮罩看着像「两层同时动」。
- 做法：浮层打开时给 `<html>` 打 `data-overlay="open"`（`hooks/useBackToClose.ts`，抽屉与底部面板共用），
  CSS 在遮罩期间压掉底层的按压高亮与过渡。**必须只压被浮层盖住的那几层**：
  全局 `button:active` 会把抽屉项与面板动作按钮一起压成透明，用户点了像没反应。
- 两个真机才会暴露的坑：
  1. **同权重平局**：外壳里的 `[data-overlay='open'] .content [class*='row']:active` 与表格自己的
     `.table[data-layout='mobile'] .row:active` 都是 0,4,0 —— 平局按源码顺序，而打包后的顺序不由我们决定。
     真机实测的结果很阴：`transition: none` 生效了、`background-color` 没生效（行还在亮）。
     正解：行的覆盖写进 `DataTable.module.css`（紧挨被压的那条），并用 `html[data-overlay='open']` 提到 0,4,1。
  2. `:active` 用注入事件测不出来（`dispatchEvent(new PointerEvent('pointerdown'))` 不会让元素进 `:active`）。
- **验收方法（别再靠截图数像素）**：真机 CDP 上按元素强制伪类，再读 computed：

  ```js
  // Node 侧：DOM.enable / CSS.enable 之后
  const {root} = await send('DOM.getDocument', {depth: 0});
  const {nodeId} = await send('DOM.querySelector', {nodeId: root.nodeId, selector});
  await send('CSS.forcePseudoState', {nodeId, forcedPseudoClasses: ['active']});
  // 页面里读 getComputedStyle(el).backgroundColor / transitionDuration
  ```

  再用 `document.getAnimations().filter(a => !a.effect.target.closest('[role="dialog"]'))` 数「浮层外还剩几条」——
  R134 的读数：顶栏按钮 / 行 / ⋯ 全变透明，抽屉项与面板动作按钮保留 `--bg-active`，浮层打开后浮层外 0 条动画。
- 读 computed 时注意**过渡进行中**会拿到插值（从 0 到 0.04 的半路值是 0.004），
  判断「压没压住」要么等过渡结束、要么看 `transitionProperty` 是否被压成 `none`。