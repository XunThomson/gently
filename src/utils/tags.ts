import {hashStr, mulberry32} from './helpers';

/**
 * 风格标签：个性化推荐的基础。
 * mock 阶段由 (标题|歌手) 稳定哈希生成，保证同一首歌每次标签一致；
 * 接入真实数据源后由数据源 / 后端返回。
 */
export const MUSIC_TAGS = [
    '流行',
    '民谣',
    '摇滚',
    '电子',
    '国风',
    '治愈',
    '深夜',
    '夏日',
    '复古',
    '独立',
    '器乐',
    '都市',
] as const;

export type MusicTag = (typeof MUSIC_TAGS)[number];

/** 由种子稳定地取 count 个不重复标签 */
export function tagsOf(seed: string, count = 2): string[] {
    const rand = mulberry32(hashStr(`tags|${seed}`));
    const pool = [...MUSIC_TAGS];
    const picked: string[] = [];

    for (let i = 0; i < count && pool.length > 0; i += 1) {
        const at = Math.floor(rand() * pool.length);
        picked.push(pool.splice(at, 1)[0]);
    }
    return picked;
}

/** 专辑聚合键：同一歌手的同一张专辑归到一组 */
export const albumKey = (artist: string, album: string): string =>
    `album:${artist}|${album}`.replace(/\s+/g, '').toLowerCase();
