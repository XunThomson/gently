import type {
    Album,
    CuratedPlaylist,
    RecommendationReason,
    RecommendedAlbum,
    RecommendedPlaylist,
    RecommendedTrack,
    RecentTrack,
    TasteProfile,
    Track,
} from '../types';

/**
 * 个性化推荐的纯计算部分（无副作用、可测试）。
 *
 * 思路是常见的「内容画像 + 加权打分」：
 * 1. 用最近播放（按时间衰减、播放次数加权）与收藏聚合出**口味画像**（标签 + 歌手权重）；
 * 2. 对候选（单曲 / 专辑 / 歌单）按标签与歌手命中程度打分；
 * 3. 给出**可解释的推荐理由**（因为你听过 X / 因为你喜欢某标签 / 近期热门）。
 *
 * 真实实现会由后端个性化接口提供候选与画像，这里的打分逻辑保持同构，
 * 便于后续替换数据来源而不改 UI。
 */

/** 时间衰减半衰期：12 小时前的播放权重减半 */
const RECENCY_HALF_LIFE_MS = 12 * 3600_000;
const FAVORITE_WEIGHT = 2.5;
const ARTIST_WEIGHT = 1.6;

export function buildTasteProfile(input: {
    recent: RecentTrack[];
    favorites: Track[];
    now?: number;
}): TasteProfile {
    const now = input.now ?? Date.now();
    const tags: Record<string, number> = {};
    const artists: Record<string, number> = {};
    let sampleSize = 0;

    const accumulate = (track: Track, weight: number) => {
        sampleSize += 1;
        track.tags.forEach((tag) => {
            tags[tag] = (tags[tag] ?? 0) + weight;
        });
        artists[track.artist] = (artists[track.artist] ?? 0) + weight * ARTIST_WEIGHT;
    };

    input.recent.forEach((item) => {
        const age = Math.max(0, now - item.playedAt);
        const decay = 0.5 ** (age / RECENCY_HALF_LIFE_MS);
        // 播放次数取对数，避免单曲循环把画像带偏
        accumulate(item, (1 + Math.log2(1 + item.playCount)) * decay);
    });

    input.favorites.forEach((track) => accumulate(track, FAVORITE_WEIGHT));

    return {tags, artists, sampleSize, updatedAt: now};
}

/** 标签 + 歌手命中得分 */
export function tasteScore(
    itemTags: string[],
    artist: string | undefined,
    profile: TasteProfile,
): number {
    const tagScore = itemTags.reduce((sum, tag) => sum + (profile.tags[tag] ?? 0), 0);
    const artistScore = artist ? (profile.artists[artist] ?? 0) : 0;
    return tagScore + artistScore;
}

const maxOf = (values: Record<string, number>): number =>
    Object.values(values).reduce((max, value) => Math.max(max, value), 0);

/** 归一化命中强度到 0~1 */
const strength = (value: number, max: number): number =>
    max <= 0 ? 0 : Math.min(1, Math.round((value / max) * 100) / 100);

/** 生成推荐理由：歌手命中优先，其次标签，最后回落「近期热门」 */
export function explain(
    itemTags: string[],
    artist: string | undefined,
    profile: TasteProfile,
): RecommendationReason {
    if (profile.sampleSize === 0) return {kind: 'trending', value: '', score: 0.4};

    const artistScore = artist ? (profile.artists[artist] ?? 0) : 0;
    const maxArtist = maxOf(profile.artists);
    const maxTag = maxOf(profile.tags);

    let topTag = '';
    let topTagScore = 0;
    itemTags.forEach((tag) => {
        const value = profile.tags[tag] ?? 0;
        if (value > topTagScore) {
            topTagScore = value;
            topTag = tag;
        }
    });

    if (artistScore > 0 && artistScore >= topTagScore) {
        return {kind: 'artist', value: artist ?? '', score: strength(artistScore, maxArtist)};
    }
    if (topTagScore > 0) {
        return {
            kind: 'tag',
            value: topTag,
            score: strength(topTagScore, maxTag * itemTags.length || maxTag),
        };
    }
    return {kind: 'trending', value: '', score: 0.3};
}

/** 单曲推荐：排除已在最近播放里的曲目，避免「推荐你刚听过的」 */
export function rankTracks(
    pool: Track[],
    profile: TasteProfile,
    limit: number,
    excludeIds: ReadonlySet<string> = new Set(),
): RecommendedTrack[] {
    return pool
        .filter((track) => !excludeIds.has(track.id))
        .map((track) => ({track, score: tasteScore(track.tags, track.artist, profile)}))
        .sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title))
        .slice(0, limit)
        .map(({track}) => ({...track, reason: explain(track.tags, track.artist, profile)}));
}

export function rankAlbums(
    albums: Album[],
    profile: TasteProfile,
    limit: number,
): RecommendedAlbum[] {
    return albums
        .map((album) => ({album, score: tasteScore(album.tags, album.artist, profile)}))
        .sort((a, b) => b.score - a.score || a.album.title.localeCompare(b.album.title))
        .slice(0, limit)
        .map(({album}) => ({...album, reason: explain(album.tags, album.artist, profile)}));
}

export function rankPlaylists(
    playlists: CuratedPlaylist[],
    profile: TasteProfile,
    limit: number,
): RecommendedPlaylist[] {
    return playlists
        .map((playlist) => ({playlist, score: tasteScore(playlist.tags, undefined, profile)}))
        .sort((a, b) => b.score - a.score || a.playlist.title.localeCompare(b.playlist.title))
        .slice(0, limit)
        .map(({playlist}) => ({...playlist, reason: explain(playlist.tags, undefined, profile)}));
}

/** 画像里权重最高的若干标签，用于「口味画像」摘要 */
export function topTags(profile: TasteProfile, limit = 3): string[] {
    return Object.entries(profile.tags)
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([tag]) => tag);
}
