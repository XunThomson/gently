import type {SongRow, Track} from '../types';
import {durationToSec} from './duration';
import {grad} from './helpers';

/** 带热度的曲目：榜单列表展示与播放队列共用同一份数据 */
export interface RankedTrack extends Track {
    heat: number;
}

/**
 * 榜单行 → 可播放曲目。
 * 统一的转换入口，避免各处重复拼装 Track（封面渐变、时长解析）。
 */
export function rankedTracks(rows: SongRow[], seed: number, source = 'ranking'): RankedTrack[] {
    return rows.map((row, index) => ({
        id: `${source}:${seed}:${index}`,
        title: row.title,
        artist: row.artist,
        album: row.album,
        duration: row.dur,
        durationSec: durationToSec(row.dur),
        source,
        gradient: grad(index + (seed % 5)),
        heat: row.heat,
    }));
}
