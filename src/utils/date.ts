import type {DateSelection, Period} from '../types';

export const pad2 = (n: number): string => String(n).padStart(2, '0');

export const daysInMonth = (year: number, month: number): number =>
    new Date(year, month, 0).getDate();

/** 今天 */
export function today(): DateSelection {
    const d = new Date();
    return {year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate()};
}

/** 本周一（周一为一周起点） */
export function thisMonday(): DateSelection {
    const now = new Date();
    const dow = now.getDay() || 7;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + 1);
    return {year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate()};
}

const dateOf = (s: DateSelection) => `${s.year}-${pad2(s.month)}-${pad2(s.day)}`;

/** 榜单时间键：查询条件的唯一标识，用于缓存与稳定随机种子 */
export function toDateKey(
    period: Period,
    date: DateSelection,
    weekStart: DateSelection,
): string {
    if (period === 'week') return `w${dateOf(weekStart)}`;
    return `${period}-${dateOf(date)}`;
}

/** 榜单标题右侧的时间范围文案，如 `2025-10-01` / `09-29 – 10-05` / `2025-10` */
export function formatRange(period: Period, date: DateSelection, weekStart: DateSelection): string {
    if (period === 'year') return `${date.year}`;
    if (period === 'month') return `${date.year}-${pad2(date.month)}`;
    if (period === 'week') {
        const start = new Date(weekStart.year, weekStart.month - 1, weekStart.day);
        const end = new Date(start.getTime() + 6 * 86400000);
        return `${pad2(start.getMonth() + 1)}-${pad2(start.getDate())} – ${pad2(
            end.getMonth() + 1,
        )}-${pad2(end.getDate())}`;
    }
    return dateOf(date);
}

/** 时间戳 → `2025-10-01 20:31` */
export function formatDateTime(ts: number): string {
    const d = new Date(ts);
    return `${dateOf({year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate()})} ${pad2(
        d.getHours(),
    )}:${pad2(d.getMinutes())}`;
}

export type RelativeUnit = 'justNow' | 'minutes' | 'hours' | 'days';

/** 相对时间：返回单位与数量，由视图决定如何本地化 */
export function formatRelative(ts: number): {unit: RelativeUnit; count: number} {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return {unit: 'justNow', count: 0};
    if (minutes < 60) return {unit: 'minutes', count: minutes};

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return {unit: 'hours', count: hours};

    return {unit: 'days', count: Math.floor(hours / 24)};
}
