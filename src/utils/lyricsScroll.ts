/**
 * 歌词自动跟随的滚动算术（纯函数）。
 *
 * 为什么不用 `scrollIntoView({behavior:'smooth'})`：
 * 1. 浏览器自带的平滑滚动不接受「每帧走近多少」的控制，长距离跳转和相邻两行
 *    用的是同一条曲线，读起来前快后慢、还容易在连续切行时互相打断；
 * 2. 用户自己滚动时，`scrollIntoView` 会立刻把人拽回去——参考 Netodia 的做法，
 *    应该先让读者看完，再回到当前行；
 * 3. 目标位置必须把**整行**（原文 + 译文）在视口里居中，而不是只看文字行。
 *
 * 这里只留下两段可测的算术，DOM 读写留在 `Lyrics` 组件里。
 */

/** 让 `activeTop` 处、高 `activeHeight` 的行在视口里居中时的滚动位置（不小于 0）。 */
export function lyricsScrollTarget(
    activeTop: number,
    activeHeight: number,
    viewportHeight: number,
): number {
    if (!Number.isFinite(activeTop) || !Number.isFinite(activeHeight) || !Number.isFinite(viewportHeight)) {
        return 0;
    }
    if (viewportHeight <= 0) return Math.max(0, activeTop);
    return Math.max(0, activeTop + activeHeight / 2 - viewportHeight / 2);
}

/**
 * 从 `current` 向 `target` 走近一帧。
 *
 * 距离小于 `settlePx` 时直接落到目标：缓动是几何逼近，永远不会真正到达；
 * 不设这个门槛，最后几像素会一直写 `scrollTop`，每一帧都触发一次重绘。
 */
export function lyricsScrollStep(
    current: number,
    target: number,
    step: number,
    settlePx: number,
): number {
    if (!Number.isFinite(current) || !Number.isFinite(target)) return 0;
    const distance = target - current;
    if (Math.abs(distance) <= settlePx) return target;
    const ratio = Math.min(1, Math.max(0, step));
    return current + distance * ratio;
}
