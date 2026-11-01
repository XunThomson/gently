/**
 * 「在播却没在动」的判定（纯函数，冒烟直接钉）。
 *
 * 为什么需要它：R111 在真机上量到两种不同的「卡住」——
 * 1. **暂停**：元素 `paused === true`（被系统中止、被自动播放策略拦下）→ 只需要 `play()` 一次；
 * 2. **僵死**：元素 `paused === false`、也没报错，`currentTime` 却一动不动。
 *    安卓锁屏/后台一段时间后就是这种：媒体管道被掐了，元素还以为自己在播。
 *    只判 `paused` 会漏掉第 2 种，界面于是永远停在「播放中、进度不动」。
 *
 * 这里只回答「要不要动手救」：位置在阈值时间内没变化，就算僵死。
 * 刻意做成纯函数：时间与位置由调用方给，测试不需要真的等 8 秒。
 */

/** 一次采样：某个时刻元素报的播放位置（秒） */
export interface StallSample {
    position: number;
    at: number;
}

/** 判定阈值（毫秒）：连续这么久位置没动就当僵死。8 秒能滤掉正常的缓冲抖动。 */
export const STALL_THRESHOLD_MS = 8000;

/**
 * 位置是否僵死。
 *
 * @param previous 上一次采样（第一次调用传 `null`）
 * @param position 本次位置（秒）
 * @param now      本次时刻（毫秒，`Date.now()`）
 * @param thresholdMs 阈值，默认 {@link STALL_THRESHOLD_MS}
 *
 * 判定规则：位置变了 → 不僵死（并把采样推到本次）；位置没变 → 看**本次**距上次变化有多久。
 * 位置倒退（用户拖回去）同样算「变了」——那是在动，不该救。
 */
export function isStalled(
    previous: StallSample | null,
    position: number,
    now: number,
    thresholdMs: number = STALL_THRESHOLD_MS,
): boolean {
    if (!previous) return false;
    if (position !== previous.position) return false;
    return now - previous.at >= thresholdMs;
}
