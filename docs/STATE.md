---
status: active
last_verified: 2026-02-14
owner: gently
scope: 当前迭代状态与下一步
token_budget: 700
tldr: 第三轮完成：真实音频播放链路、动态背景玻璃化、播放条顶边 bilibili 式进度条 + 播放列表/功能抽屉、歌词页瘦身、日期选择器重做、搜索独立成页；typecheck / smoke(112) / build 全绿。
---

# STATE

## 本轮目标

按反馈继续优化 UI：歌词页瘦身、播放条重构、日期选择器重做、搜索独立视图，并接入提供的测试音频与动态背景。

## 已完成（第三轮）

- **真实音频播放链路**：`services/audio.service.ts` + `hooks/useAudioEngine`。
  数据源 `resolveUrl` 下发内置测试音频 `src/assets/yihuik苡慧 - 致你.m4s`；
  `<audio>` 的 timeupdate 回写进度/时长，ended 自动下一首，播放失败则 `markUnplayable()`
  退回模拟时钟（`player.playable` 是唯一开关）。
- **动态背景**：`components/shell/background` 把 `src/assets/bgc.mp4` 以 `object-fit: cover`
  铺满整个视图；`html[data-video-bg='on']` 触发 `--surface-chrome` 切换为半透明，
  外壳玻璃化；透明度 / 模糊 / 遮罩由 `components.background` 配置，reduced-motion 下自动关闭。
- **播放条重构**：
  - 进度条移到播放条**顶边**（`SeekBar`）：默认只有细进度线，悬浮 / 聚焦 / 拖拽时放大并显示焦点，
    指针位置显示时间预览；焦点皮肤 `default | glow | ring` 由 `playerBar.progressThumbSkin` 配置。
  - 歌曲信息（封面 / 标题 / 歌手·专辑 / 时长·来源）在播放条展示。
  - 新增**播放列表抽屉**（当前曲目 + 队列，点击切换）与**功能抽屉**（收藏 / 下载 / 加入歌单 / 打开歌词页）。
- **歌词页瘦身**：`/now-playing` 只保留「封面 + 歌词」，信息与功能性操作全部移出。
- **日期选择器重做**：日榜默认只显示月份日历（年份点击标题才展开）、选中今天显示「今天」；
  月榜显示 12 个月 chip + 年份步进器；年榜显示最近 12 年；周榜只显示「本周」，
  删除 WeekChips 与旧的滚轮实现。
- **搜索独立成页**：`/search?q=`，URL 即状态（可分享 / 刷新 / 前进后退），
  顶栏搜索提交后跳转；热门推荐页回归纯推荐。
- **工程**：`assetsInclude` 支持 `.m4s`；冒烟测试扩到 112 项
  （新增音源解析、进度回写、回退时钟、抽屉与搜索视图渲染）。

## 验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | 通过 |
| 冒烟测试 | `pnpm smoke` | 112/112 通过 |
| 生产构建 | `pnpm build` | 通过，主包 460 KB（gzip 149 KB）；媒体资源单独产出 |

## 下一步

1. 真实音乐源插件替换内置示例源（`resolveUrl` 返回真实地址，播放链路无需改动）。
2. 队列增强：拖拽排序、从此曲播放、清空队列。
3. 日期选择器补周榜历史（当前按需求只显示本周）。
4. 浏览器人工走查：动态背景 + 6 套主题 + 浅深色的可读性。
5. `pnpm tauri build` 验证 window 权限标识符。

## 风险

- `src/assets/bgc.mp4` 约 **105 MB**：会显著增大仓库体积。若不想入库，可改为
  `import.meta.glob` 可选加载 + `.gitignore`（需同步改 `BackgroundVideo.tsx`）。
- `.m4s` 的可播放性取决于宿主解码器：浏览器 / WebView2 若不支持，会自动退回模拟时钟
  （进度照常推进，但没有声音）。
- 视觉正确性仍依赖人工确认（环境无法截图）。
