/**
 * 桌面歌词窗口的摆放规则（**纯函数**，窗口服务与冒烟测试共用同一份实现）。
 *
 * 为什么需要「要不要记住位置」的判断：用户把歌词条拖到别处之后，下次显示如果又跳回
 * 屏幕底部居中，他会觉得「拖了没用」；但如果把窗口拖到副屏、之后副屏拔了，还硬按旧坐标
 * 摆放就会把窗口放到**看不见的地方**（用户以为它没打开）。所以规则是：
 *
 * 1. 记得的位置**仍然落在某块屏幕里**（至少露出大半个窗口）→ 用它，并把它夹回该屏幕范围内；
 * 2. 否则（第一次、副屏没了、分辨率变了）→ 回到底部居中，这个位置永远可见。
 */

export interface Position {
    x: number;
    y: number;
}

export interface Size {
    width: number;
    height: number;
}

/** 一块屏幕：左上角坐标 + 尺寸（与 Tauri 的 `Monitor` 同形）。 */
export interface MonitorRect {
    position: Position;
    size: Size;
}

/** 底部居中时离屏幕底边的距离（留出任务栏与播放条的观感）。 */
export const LYRICS_BOTTOM_MARGIN = 72;

/** 至少要有这么大比例的窗口面积落在某块屏幕里，才算「看得见」。 */
const MIN_VISIBLE_RATIO = 0.5;

function clamp(value: number, min: number, max: number): number {
    if (max < min) return min;
    return Math.min(Math.max(value, min), max);
}

/** 窗口与某块屏幕的重叠面积占窗口面积的比例。 */
function visibleRatio(position: Position, size: Size, monitor: MonitorRect): number {
    const left = Math.max(position.x, monitor.position.x);
    const top = Math.max(position.y, monitor.position.y);
    const right = Math.min(position.x + size.width, monitor.position.x + monitor.size.width);
    const bottom = Math.min(position.y + size.height, monitor.position.y + monitor.size.height);
    if (right <= left || bottom <= top) return 0;
    return ((right - left) * (bottom - top)) / (size.width * size.height);
}

/** 底部居中（用第一块屏幕：调用方按「主窗口所在屏幕优先」的顺序传入）。 */
export function defaultLyricsPosition(monitors: MonitorRect[], size: Size): Position {
    const monitor = monitors[0] ?? {position: {x: 0, y: 0}, size: {width: 0, height: 0}};
    const x = monitor.position.x + Math.round((monitor.size.width - size.width) / 2);
    const y = monitor.position.y + monitor.size.height - size.height - LYRICS_BOTTOM_MARGIN;
    // 屏幕比窗口还小时 `max` 会算出负数：夹到 0 起点，至少左上角可见
    return {
        x: Math.max(monitor.position.x, x),
        y: Math.max(monitor.position.y, y),
    };
}

/**
 * 这一次显示放哪：记得的位置可用就用（夹回屏幕内），否则底部居中。
 */
export function placeLyrics(
    saved: Position | null,
    monitors: MonitorRect[],
    size: Size,
): Position {
    if (!saved || monitors.length === 0) return defaultLyricsPosition(monitors, size);

    const visible = monitors.find((monitor) => visibleRatio(saved, size, monitor) >= MIN_VISIBLE_RATIO);
    if (!visible) return defaultLyricsPosition(monitors, size);

    // 记得的位置可能只露出一半：夹进这块屏幕，保证整条歌词都看得见
    return {
        x: clamp(saved.x, visible.position.x, visible.position.x + visible.size.width - size.width),
        y: clamp(saved.y, visible.position.y, visible.position.y + visible.size.height - size.height),
    };
}
