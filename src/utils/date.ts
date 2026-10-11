export const pad2 = (n: number): string => String(n).padStart(2, '0');

const dateOf = (year: number, month: number, day: number) =>
    `${year}-${pad2(month)}-${pad2(day)}`;

/** 时间戳 → `2025-10-01 20:31` */
export function formatDateTime(ts: number): string {
    const d = new Date(ts);
    return `${dateOf(d.getFullYear(), d.getMonth() + 1, d.getDate())} ${pad2(
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
