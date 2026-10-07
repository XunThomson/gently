# src/config — 可定制内容索引

改任何可见行为/样式前，先在这里找到对应的「唯一来源」，不要在组件里写死。

| 想改什么 | 改哪里 | 生效方式 |
|---|---|---|
| 颜色、字号、间距、圆角、阴影、动效、层级 | `theme/theme.config.json` | 运行时注入 CSS 变量，刷新即生效 |
| 某个组件的尺寸/度量（标题栏、搜索框、侧边栏、播放条、表格、卡片、榜单、按钮、歌词、空态、日期选择器…） | `theme/theme.config.json` → `components` | 同上，组件 CSS 只消费 `var(--token)` |
| 主题皮肤与「密度」（配色 + 行高/间距/布局/圆角/阴影/动效） | `theme/presets.json` | 皮肤市场里选择 / 导入，立即生效并持久化 |
| 用户导入的皮肤 | 皮肤市场「导入皮肤」(JSON) | 存 localStorage，可导出分享 |
| 动态背景（视频透明度/模糊/遮罩/玻璃模糊半径） | `theme/theme.config.json` → `components.background` | 素材见 `src/assets/README.md` |
| 行为与规模：窗口尺寸、音量/进度步长、列表条数、下载引擎、mock 数据量、模拟延迟 | `app.config.ts` | 构建期常量，改后重新构建 |
| 危险操作是否需要二次确认 | 设置页开关（`ui.confirmDestructive`） | 运行时，持久化 |
| 界面文案（中/英） | `src/i18n/locales/*.json` | 运行时切换语言 |
| 列表列（标题/宽度/对齐/渲染） | `src/config/table.config.tsx` | 视图只做组合 |
| 推荐算法权重（时间衰减 / 收藏加权 / 歌手加权） | `src/utils/recommend.ts` 顶部常量 | 纯函数，可被测试覆盖 |
| 导航菜单（名称/图标/顺序/是否显示） | `src/router/meta.tsx` 的 `meta` | 菜单由路由派生，单一来源 |
| 后端接口（路径/字段/错误码） | `src/api/**` + `docs/contracts/backend-api.md` | 契约，实现后由 `src/services/**` 接入 |
| 假数据内容（曲库、歌单、下载、插件、歌词） | `src/mock/**` | 接入真实数据源后由 `src/services/**` 替换 |

## 三个文件的分工

```
theme/theme.config.json   样式元数据（皮肤可以换，结构不变）   运行时
theme/presets.json        主题市场预设（覆盖 palette / scheme / components）
app.config.ts             行为与规模（产品行为，不随主题变化）  构建期
```

## 新增一个可定制项的正确姿势

1. 在 `theme/theme.config.json` 的对应组件组里加字段（值写默认值）；
2. 在 `theme/types.ts` 的 `ComponentTokens` 同步字段类型；
3. 在 `theme/tokens.ts` 映射成 CSS 变量（`--<组件>-<含义>`）；
4. 组件 CSS 里用 `var(--token)`，删掉原来的字面量；
5. 跑 `pnpm smoke`：其中的 `css: 引用的 token 全部有定义` 会拦下拼错的变量名；
6. 如果这个值也允许被主题预设覆盖，在 `presets.json` 的某个预设里声明即可（无需改代码）。

## 允许保留字面量的情况

- 0 / 100% / 1px 边框 / transparent / none / auto；
- 透明度、缩放、动画关键帧等不适合外置的值；
- 绝不可能变化的符号（例如表头的 `#`）。

其余一律走 config + token，这样主题市场与后续「皮肤包」才能覆盖到。
