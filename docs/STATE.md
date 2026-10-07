---
status: active
last_verified: 2026-02-14
owner: gently
scope: 当前迭代状态与下一步
token_budget: 800
tldr: 第六轮：防误操作二次确认、个性化推荐（专辑/歌单/理由）、后端接口契约、复杂皮肤（全令牌覆盖 + 导入导出）；typecheck / smoke(172) / build 全绿，依赖已分包。
---

# STATE

## 本轮目标

四项：危险操作二次确认、推荐扩展到专辑/歌单并个性化、后端接口规范、更复杂的主题皮肤。

## 已完成（第六轮）

### 1. 防误操作的二次确认
- 新增 `dialog` 切片 + `useConfirm()` + `ConfirmHost`（App 内挂载一次）+ `ConfirmDialog`
  （Esc 取消 / Enter 确认 / 打开聚焦取消 / Tab 环绕 / 遮罩点击取消 / `role="alertdialog"`）；
- 设置里可关闭「危险操作前二次确认」，关闭后直接执行；
- 已接入 8 处：删除歌单（侧边栏、歌单页）、卸载音源插件、清空播放列表、清空播放记录、
  清理已完成下载、移除本地音乐、移除下载任务、删除皮肤。

### 2. 个性化推荐（不再只是单曲）
- 模型新增 `Album` / `CuratedPlaylist` / `TasteProfile` / `RecommendationReason`，
  `Track` 增加 `tags` 与 `albumId`（稳定哈希生成，接入真实源后由其提供）；
- `utils/recommend.ts`：口味画像（播放次数取对数、12h 半衰期衰减、收藏加权）+
  标签/歌手打分 + **可解释理由**（因为你听过 X / 因为你喜欢某标签 / 近期热门）；
- `services/recommend.service.ts` + `recommend` 切片；推荐页改为三区块：
  **为你推荐（单曲）/ 推荐专辑 / 推荐歌单**，每条带 ReasonChip，顶部显示口味画像摘要；
- 新增 `album-grid` / `playlist-grid` / `reason-chip` 三个通用组件；
  `TrackGrid` 支持 `reasonOf` 展示推荐理由。

### 3. 后端接口规范（只有契约，无实现）
- `src/api/types.ts`：统一信封 `ApiResult<T>`、游标分页、幂等写、错误码、实时事件；
- `src/api/contract.ts`：8 个域的能力接口 `GentlyApi`
  （auth / catalog / library / recommend / playback / plugin / download / skin）；
- `docs/contracts/backend-api.md`：版本与命名、错误模型、分页、认证、**多音源策略**、
  端点清单、实时通道、**前端替换映射表**、非功能性要求（限流/缓存/可观测/兼容/安全）。

### 4. 复杂主题皮肤
- `ThemePreset` 升级为 `ThemeSkin`：可覆盖**任意令牌组**（含 typography / radius / spacing /
  shadow / motion / zIndex / components）；
- 内置皮肤扩到 **11 套**，新增三套复杂皮肤：**圆润**（大圆角 + 柔和阴影 + 慢动效）、
  **锐利**（小圆角 + 无阴影 + 快动效 + 紧凑行高）、**高对比**（更强边框与字重 + 更大字号）；
- 主题市场升级为**皮肤市场**：搜索、标签筛选、自定义标记、应用/删除（带确认）、
  **导入/导出皮肤 JSON**（结构校验，失败给出原因），自定义皮肤持久化到本地。

### 工程
- 依赖分包（react / router / i18n 独立 chunk）：主包从 500KB 降到 **338KB（gzip 110KB）**，
  构建不再报警；
- 冒烟测试扩到 **172 项**：新增二次确认状态机、推荐画像/排序/理由/排除、皮肤合并与导入校验，
  以及新组件（ConfirmDialog / AlbumGrid / PlaylistGrid / ReasonChip）的渲染断言。

## 验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | 通过 |
| 冒烟测试 | `pnpm smoke` | 172/172 通过 |
| 生产构建 | `pnpm build` | 通过，主包 338 KB（gzip 110 KB） |

## 下一步

1. 接入后端：按 `docs/contracts/backend-api.md` 第 8 节替换 `src/services/**`（UI/store 不动）。
2. 真实音乐源插件 + 由后端承担多音源回退。
3. 推荐反馈闭环：把 `skip / like / complete` 上报（接口已定义），并让本地打分消费反馈。
4. 专辑 / 歌单详情页（当前推荐页点击即整列表播放）。
5. 浏览器人工走查：11 套皮肤 × 浅深色、二次确认交互、推荐页三区块。

## 风险

- 推荐全部本地计算：候选池是内置曲库（mock），真实个性化需后端。
- 皮肤导入仅做结构校验（不执行代码），但未做「令牌键名白名单」，异常键名会被忽略而非报错。
- 三个模拟音源共享同一测试音频；本地曲目在 mock 阶段无可播地址。
- 动态背景素材不入库（见 `src/assets/README.md`）。
- 视觉正确性依赖人工确认（环境无法截图）。
