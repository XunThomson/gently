import {GRADIENTS, SONG_POOL} from './base.data.mock';
import type {Track} from '../types';
import {hashStr, mulberry32} from '../utils/helpers';
import {durationToSec} from '../utils/duration';
import {albumKey, tagsOf} from '../utils/tags';

/**
 * 由曲库行构造统一 Track。
 * 使用稳定哈希保证同一 (source, index) 永远得到相同的 id / 封面 / 标签。
 */
export function makeTrack(index: number, source = 'mock'): Track {
    const row = SONG_POOL[index % SONG_POOL.length];
    const [title, artist, album, duration] = row;
    return {
        id: `${source}:${index}`,
        title,
        artist,
        album,
        duration,
        durationSec: durationToSec(duration),
        source,
        gradient: GRADIENTS[index % GRADIENTS.length],
        tags: tagsOf(`${title}|${artist}`),
        albumId: albumKey(artist, album),
    };
}

/** 生成 count 条确定性曲目（seed 决定顺序，便于 mock 复现） */
export function makeTracks(count: number, seed = 'tracks', offset = 0, source = 'mock'): Track[] {
    const rand = mulberry32(hashStr(seed));
    const indexes = SONG_POOL.map((_, i) => i);

    for (let i = indexes.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
    }

    return indexes
        .slice(0, count)
        .map((i) => makeTrack(i + offset * SONG_POOL.length, source));
}
