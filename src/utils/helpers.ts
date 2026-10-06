import {GRADIENTS} from '../mock/base.data.mock.ts';

export const grad = (i: number): string =>
    GRADIENTS[((i % GRADIENTS.length) + GRADIENTS.length) % GRADIENTS.length];

/** 稳定可复现的伪随机数发生器 */
export function mulberry32(a: number): () => number {
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function hashStr(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export function fmt(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
}

export function matchesQuery(...fieldsAndQuery: string[]): boolean {
    const query = fieldsAndQuery[fieldsAndQuery.length - 1].trim().toLowerCase();
    if (!query) return true;
    return fieldsAndQuery
        .slice(0, -1)
        .some((field) => field.toLowerCase().includes(query));
}
