/**
 * 窗口尺寸 → 外壳形态的裁决（纯函数，冒烟测试直接钉住）。
 *
 * 四种形态共用同一套断点，避免每个组件各自写一遍 `@media`：
 * - `regular`：完整界面（侧栏 + 标题栏 + 播放条）；
 * - `compact`：紧凑界面（侧栏收成图标栏、标题栏收起品牌文字）；
 * - `mini`：迷你播放器（整个外壳替换，只有封面 / 标题 / 控制 / 进度 / 歌词）；
 * - `mobile`：手机外壳（底部 tab + 单栏内容 + 常驻播放条），**不看尺寸，只看平台**。
 *
 * 没有尺寸（SSR、首帧、浏览器未挂载）时按 `regular` 处理：
 * 宁可多渲染一次完整界面，也不要在首帧闪一下迷你播放器。
 *
 * `mobile` 优先于尺寸：手机竖屏（约 412×915）本来会落进 `mini`，
 * 那是「把窗口缩小」的桌面语义，而不是「在手机上用」的意思。
 */
export type ShellMode = 'regular' | 'compact' | 'mini' | 'mobile';

/** 形态判定需要的平台（与 `utils/platform.ts` 的 `AppPlatform` 同构） */
export type ShellPlatform = 'desktop' | 'mobile';

export interface ShellBreakpoints {
    /** 宽低于此值进入紧凑模式（紧凑只由宽度决定；高度不足时直接进迷你） */
    compactWidth: number;
    /** 宽 / 高低于此值进入迷你播放器 */
    miniWidth: number;
    miniHeight: number;
}

export function resolveShellMode(
    width: number,
    height: number,
    breakpoints: ShellBreakpoints,
    platform: ShellPlatform = 'desktop',
): ShellMode {
    if (platform === 'mobile') return 'mobile';
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return 'regular';
    }
    if (width < breakpoints.miniWidth || height < breakpoints.miniHeight) return 'mini';
    if (width < breakpoints.compactWidth) return 'compact';
    return 'regular';
}
