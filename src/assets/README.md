# src/assets

## 入库的素材

| 文件 | 用途 | 说明 |
|---|---|---|
| `yihuik苡慧 - 致你.m4s` | 播放链路测试音频 | 标准 MP4/AAC（`ftyp iso5` + `mp4a`），约 4MB；内置示例源把它作为所有曲目的播放地址，仅用于验证播放/暂停/进度/音量 |
| `css/` | 全局样式入口 | `main.css` → `global.css` + `utilities.css` |

## 不入库的素材（本地测试用）

| 文件 | 用途 | 说明 |
|---|---|---|
| `bgc.mp4` | 动态背景测试视频 | **约 105MB，已加入 `.gitignore`**，请自行放回本目录 |

`bgc.mp4` 缺失时的行为：

- `components/shell/background/BackgroundVideo.tsx` 用 `import.meta.glob` 可选加载，
  **构建不会失败**，动态背景自动关闭，其余功能不受影响；
- 开发模式下会在控制台提示文件缺失。

需要本地看到动态背景效果时，把测试视频放回：

```
src/assets/bgc.mp4
```

`bgc.mp4` 的显示参数（透明度 / 模糊 / 遮罩 / 玻璃模糊半径）在
`src/config/theme/theme.config.json` 的 `components.background` 中配置。
