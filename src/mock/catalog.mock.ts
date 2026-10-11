import type {Album, CuratedPlaylist, Track} from '../types';
import {SONG_POOL} from './base.data.mock';
import {makeTrack} from './track.mock';
import {tagsOf} from '../utils/tags';
import {hashStr, mulberry32} from '../utils/helpers';
import {GRADIENTS} from './base.data.mock';

/**
 * 专辑与编辑精选歌单（mock）。
 *
 * - 专辑按「歌手」归集内置曲库，形成每张 3~4 首的专辑；
 * - 精选歌单提供标题、描述与风格标签，供个性化推荐打分。
 */

/** 全部专辑：按歌手归集，标题取该歌手第一首歌的专辑名 */
export function buildAlbums(): Album[] {
    const byArtist = new Map<string, Track[]>();

    SONG_POOL.forEach((row, index) => {
        const artist = row[1];
        const list = byArtist.get(artist) ?? [];
        list.push(makeTrack(index, 'mock'));
        byArtist.set(artist, list);
    });

    return [...byArtist.entries()].map(([artist, tracks], order) => ({
        id: `album:${artist}`,
        title: tracks[0].album,
        artist,
        cover: GRADIENTS[order % GRADIENTS.length],
        year: 2025 - (hashStr(artist) % 4),
        tags: tagsOf(`album|${artist}`, 3),
        source: 'mock',
        tracks,
    }));
}

/** 编辑精选歌单的种子数据：曲目索引 + 风格标签 */
const PLAYLIST_SEEDS: {id: string; title: string; description: string; tags: string[]; indexes: number[]}[] = [
    {
        id: 'curated:midnight',
        title: '深夜安静电台',
        description: '适合独处与入睡前的低频人声',
        tags: ['深夜', '治愈', '民谣'],
        indexes: [0, 6, 8, 14, 21],
    },
    {
        id: 'curated:commute',
        title: '通勤充电站',
        description: '节奏明快，适合路上与跑步',
        tags: ['流行', '都市', '电子'],
        indexes: [1, 12, 16, 18, 23],
    },
    {
        id: 'curated:summer',
        title: '夏日海边',
        description: '清爽的和弦与海浪感编曲',
        tags: ['夏日', '流行', '独立'],
        indexes: [4, 12, 19, 26],
    },
    {
        id: 'curated:retro',
        title: '旧唱片机',
        description: '复古质感与模拟味',
        tags: ['复古', '器乐', '独立'],
        indexes: [5, 20, 27, 10],
    },
    {
        id: 'curated:focus',
        title: '专注工作流',
        description: '低干扰器乐，长时间不疲劳',
        tags: ['器乐', '电子', '深夜'],
        indexes: [7, 9, 24, 15, 22],
    },
    {
        id: 'curated:guofeng',
        title: '国风新声',
        description: '传统器乐与当代编曲的结合',
        tags: ['国风', '独立', '器乐'],
        indexes: [3, 11, 17, 25],
    },
];

export const CURATED_PLAYLISTS: CuratedPlaylist[] = PLAYLIST_SEEDS.map((seed, order) => ({
    id: seed.id,
    title: seed.title,
    description: seed.description,
    cover: GRADIENTS[(order + 3) % GRADIENTS.length],
    tags: seed.tags,
    source: 'mock',
    tracks: seed.indexes.map((index) => makeTrack(index, 'mock')),
}));

/** 推荐候选池：内置曲库全量（真实实现来自后端个性化接口） */
export function discoveryPool(): Track[] {
    const rand = mulberry32(hashStr('discovery'));
    const indexes = SONG_POOL.map((_, i) => i);

    for (let i = indexes.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rand() * (i + 1));
        [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
    }
    return indexes.map((index) => makeTrack(index, 'mock'));
}

/* ---------------- 详情页（浏览器预览） ----------------
 * 桌面端这两件事由核心的 `catalog.album` / `catalog.playlist` 完成，
 * 这里只保证浏览器预览里点开卡片也能看到同一形状的详情。
 */

/** 按 id 找专辑；`mock` 的专辑 id 形如 `album:<歌手>` */
export function findAlbum(id: string): Album | null {
    return buildAlbums().find((album) => album.id === id) ?? null;
}

/** 按 id 找精选歌单；id 形如 `curated:<slug>` */
export function findCuratedPlaylist(id: string): CuratedPlaylist | null {
    return CURATED_PLAYLISTS.find((playlist) => playlist.id === id) ?? null;
}
