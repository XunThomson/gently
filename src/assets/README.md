# src/assets

## 入库的素材

| 文件 | 用途 | 说明 |
|---|---|---|
| `css/` | 全局样式入口 | `main.css` → `global.css` + `utilities.css` |

## 不入库的素材（本地测试用，各人自备）

**仓库不分发版权音频与视频**——这些文件只在本机存在，`.gitignore` 已排除，`git clone` 下来的仓库里没有它们。

| 文件 | 用途 | 说明 |
|---|---|---|
| `yihuik苡慧 - 致你.m4s` | 播放链路测试音频 | 标准 MP4/AAC（`ftyp iso5` + `mp4a`），约 4MB。用来验证「播放 / 暂停 / 进度 / 音量」整条链路，以及 `library.local.scan` 对 ISO-MP4 副扩展名的识别 |
| `bgc.mp4` | 动态背景测试视频 | 约 105MB；需要看动态背景效果时自行放回本目录 |

缺失时的行为（**构建不会失败**，都按设计降级）：

- **`*.m4s` 缺失**：`src/plugins/builtin/source-factory.ts` 用 `import.meta.glob` 可选加载本地音频，
  没有就退回一段**内联静音 WAV**（data URL）——演示源仍给得出播放地址，
  播放/进度这条链路的冒烟断言照常成立，只是听不到声音；
  `core/tests/local_library.rs` 的 `m4s_container_is_indexed_like_any_other_audio_file` 会打印一行
  「跳过」并退出（白名单本身由 `core/src/local_library.rs` 里的纯函数单测守着）。
- **`bgc.mp4` 缺失**：`components/shell/background/BackgroundVideo.tsx` 用 `import.meta.glob` 可选加载，
  动态背景自动关闭，其余功能不受影响；开发模式下控制台会提示文件缺失。

`bgc.mp4` 的显示参数（透明度 / 模糊 / 遮罩 / 玻璃模糊半径）在
`src/config/theme/theme.config.json` 的 `components.background` 中配置。
