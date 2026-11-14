/**
 * 随机播放的选曲（纯函数，冒烟可直接钉住）。
 *
 * 规则很简单，但必须可测：
 * - 队列为空或只有一首时返回 `-1`（调用方据此停表，而不是重复播同一首）；
 * - 永远不返回当前下标（否则「下一首」看起来像没反应）；
 * - `random` 可注入，测试用固定值覆盖边界。
 */
export function pickShuffleIndex(
    length: number,
    currentIndex: number,
    random: () => number = Math.random,
): number {
    if (!Number.isInteger(length) || length <= 1) return -1;

    const current =
        Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < length
            ? currentIndex
            : -1;
    const raw = Math.floor(random() * length);
    const candidate = Math.min(length - 1, Math.max(0, Number.isFinite(raw) ? raw : 0));
    if (candidate !== current) return candidate;

    /* 随机到当前曲目：取下一首（越界回 0）。比「再随机一次」更确定，
       也不会在 2 首队列里出现偶发不切歌。 */
    return (current + 1) % length;
}
