export const clamp = (v: number, a: number, b: number): number =>
    Math.max(a, Math.min(b, v));

let _seq = 0;
export const uid = (prefix = 'n'): string =>
    `${prefix}_${(++_seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const PAD = 16;