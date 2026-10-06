import { SONG_POOL } from '../mock/base.data.mock.ts';
import { TOTAL_PER_CHART } from '../constants';
import { hashStr, mulberry32 } from './helpers';
import type { ChartType, SongRow } from '../types';

export function buildChartData(chart: ChartType, key: string): SongRow[] {
    const rand = mulberry32(hashStr(`${chart}|${key}`));
    const arr = [...SONG_POOL];

    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }

    const baseHeat = 88 + (hashStr(key) % 12);

    return arr.slice(0, TOTAL_PER_CHART).map((s, i) => {
        const noise = Math.floor(rand() * 4);
        const heat = Math.max(50, Math.round(baseHeat - i * 1.8 - noise));
        return { title: s[0], artist: s[1], album: s[2], dur: s[3], heat };
    });
}