---
status: active
last_verified: 2026-02-14
owner: gently
scope: 当前迭代状态与下一步
token_budget: 800
tldr: 第四轮：把「可定制内容」做成体系——主题令牌扩到 18 个组件组、主题预设可覆盖密度/布局、行为参数集中到 app.config.ts，并补齐动态背景玻璃化、大素材不入库、音频 MIME 兜底。typecheck / smoke(118) / build 全绿。
---

# STATE

## 本轮目标

按反馈「加入更多的可定制内容」把配置面做成体系，并把上一轮遗留的三个决策拍板落地。

## 已完成（第四轮）

### 可定制内容体系化

- **主题令牌扩展到 18 个组件组**：titleBar / searchBox / toolbar / sidebar / playerBar / panel /
  button / lyrics / emptyState / radioGroup / hero / datePicker / background / view / section /
  dataTable / card / chart。原先写在 CSS 里的可见尺寸、间距、字号、颜色基本都可由
  `src/config/theme/theme.config.json` 控制。
- **主题预设可覆盖密度与布局**：`presets.json` 的预设现在除 palette / scheme 外，
  还能按组件组覆盖 `components`（行高、间距、侧边栏宽度、播放条高度…）。
  新增两套密度预设：**紧凑**（一屏更多内容）与**宽适**（放宽留白）。
  外壳（App / 标题栏 / 播放条 / 动态背景）改为读取 `useTheme().config`，
  因此切换密度预设会立即改变布局，而不再只影响颜色。
- **行为参数集中到 `src/config/app.config.ts`**：窗口尺寸、音量/进度步长、
  「上一首」回到开头的阈值、回退时钟间隔、列表条数（榜单/推荐/搜索/最近上限）、
  下载引擎步长与体积估算、歌词 mock 生成参数、mock 数据规模、模拟延迟。
  删除了遗留的 `src/constants/`（两个常量并入 app.config）。
- **新增 `src/config/README.md`**：一张「想改什么 → 改哪里」的索引，
  以及新增可定制项的标准步骤。
- 冒烟测试新增密度预设断言（覆盖生效、未声明字段继承、CSS 变量注入），共 **118** 项。

### 上一轮遗留决策（已拍板）

1. **105MB 动态背景素材不入库**：`src/assets/bgc.mp4` 已 `git rm --cached` 并加入 `.gitignore`；
   `BackgroundVideo` 改用 `import.meta.glob` 可选加载 —— 文件缺失时**构建不会失败**、
   动态背景自动关闭，其余功能不受影响（已实测：移走文件后 `pnpm build` 通过）。
   本地想看效果把文件放回原路径即可（见 `src/assets/README.md`）。
   历史提交里仍留有该 blob，如需彻底瘦身需重写历史（未执行，属破坏性操作）。
2. **玻璃化可读性**：遮罩改为跟随明暗方案（`scheme.videoScrim`），半透明表面 alpha 提高，
   并给外壳加上真正的背景模糊（`--surface-blur` = `blur(--bg-surface-blur) saturate(140%)`），
   由 `components.background.surfaceBlurPx` 配置。
3. **`.m4s` 播放**：保留原始文件名，`audio.service` 对非常规扩展名先抓成 Blob 并强制
   `audio/mp4` 再交给 `<audio>`，规避 `octet-stream` 导致无法解码；失败仍会退回模拟时钟。

### 有意保留的设计调整

令牌化时有四处数值与原字面量不同，均为有意的设计微调（已确认保留）：
歌词字号 15（原 14）、歌词当前行 17（原 16）、歌词行距 14（原 8，歌词页更透气）、
页面副标题 13（原 14）；HeroCard 内边距 30/26（原 32/24）、封面圆角 18（原 14）。

## 验证

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | 通过 |
| 冒烟测试 | `pnpm smoke` | 118/118 通过 |
| 生产构建 | `pnpm build` | 通过（含视频缺失场景） |

## 下一步

1. 真实音乐源插件替换内置示例源。
2. 队列增强：拖拽排序、从此曲播放、清空队列。
3. 日期选择器补周榜历史。
4. 浏览器人工走查：动态背景 + 8 套预设 × 浅深色的可读性。
5. `pnpm tauri build` 验证 window 权限标识符。

## 风险

- 动态背景素材不入库：新克隆默认没有背景（构建正常），需要时自行放置。
- 历史提交仍含 105MB blob；彻底瘦身需重写历史（破坏性，需你确认）。
- 视觉正确性依赖人工确认（环境无法截图）。
