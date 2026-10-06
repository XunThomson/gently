/** 时长解析与格式化（纯函数） */

/** '3:42' → 222 */
export function durationToSec(duration: string): number {
    const [m, s] = duration.split(':').map(Number);
    return (m || 0) * 60 + (s || 0);
}

/** 222 → '3:42' */
export function secToDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    return `${m}:${String(sec % 60).padStart(2, '0')}`;
}
