/**
 * 手机歌词页「下滑关闭」的判定（R144）。
 *
 * 为什么抽纯函数：手势阈值既不能太小（歌词区向下滚一下就误关），也不能太大
 * （短屏幕上怎么拉都关不掉）。这里用「固定下限 + 视口比例」两者取更容易达到的那个：
 * - 至少 96px；
 * - 或超过视口高度的 18%（大屏手机不用拉很长）。
 *
 * 只负责判定，不碰 DOM：`MobileNowPlaying` 里把拖动距离传进来即可，冒烟可以直接钉住。
 */
export const NOW_PLAYING_DISMISS_MIN_PX = 96;
export const NOW_PLAYING_DISMISS_RATIO = 0.18;

export function shouldDismissNowPlaying(dragPx: number, viewportHeight: number): boolean {
    if (!Number.isFinite(dragPx) || dragPx <= 0) return false;
    const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
    return dragPx >= NOW_PLAYING_DISMISS_MIN_PX || (height > 0 && dragPx >= height * NOW_PLAYING_DISMISS_RATIO);
}

/** 拖动时页面的透明度/位移：越往下越接近「退场」，但保留一点内容让用户知道没关死 */
export function nowPlayingDragOpacity(dragPx: number, viewportHeight: number): number {
    const distance = Math.max(0, dragPx);
    const height = viewportHeight > 0 ? viewportHeight : 1;
    return Math.max(0.35, 1 - distance / (height * 1.4));
}
