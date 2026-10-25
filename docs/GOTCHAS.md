---
status: active
last_verified: 2026-10-25
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

## 19. 内容透明度不能用容器的 `opacity`（R86）

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
