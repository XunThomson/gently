import type {GroupedTrack, SongRow, Track, TrackCandidate, TrackQuality} from '../types';
import {durationToSec} from './duration';
import {grad} from './helpers';
import {albumKey, tagsOf} from './tags';

/** 带热度的曲目：榜单列表展示与播放队列共用同一份数据 */
export interface RankedTrack extends Track {
    heat: number;
}

/**
 * 榜单行 → 可播放曲目。
 * 统一的转换入口，避免各处重复拼装 Track（封面渐变、时长解析、标签）。
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
        tags: tagsOf(`${row.title}|${row.artist}`),
        albumId: albumKey(row.artist, row.album),
        heat: row.heat,
    }));
}

/** 聚合键：同一首歌在不同音源下的标题/歌手可能有空格、括号差异 */
const normalize = (value: string): string =>
    value
        .toLowerCase()
        .replace(/[（(【[].*?[)）】\]]/g, '')
        .replace(/[\s·・\-—_]/g, '');

export const trackGroupKey = (track: Track): string =>
    `${normalize(track.title)}|${normalize(track.artist)}`;

/**
 * 把多音源结果聚合成「一首歌一条」。
 *
 * - 同一 (标题, 歌手) 只保留一条，其余作为音源候选挂在 `candidates`；
 * - `GroupedTrack` 自身的字段取第一个候选（即优先级最高的音源）；
 * - 候选顺序即播放尝试顺序（调用方可先用 `sortCandidates` 按用户偏好排好）。
 */
export function groupTracks(
    tracks: Track[],
    qualitiesOf: (source: string) => readonly TrackQuality[] = () => ['standard'],
): GroupedTrack[] {
    const groups = new Map<string, {primary: Track; candidates: TrackCandidate[]}>();

    for (const track of tracks) {
        const key = trackGroupKey(track);
        const existing = groups.get(key);

        if (existing) {
            if (!existing.candidates.some((item) => item.source === track.source)) {
                existing.candidates.push({
                    source: track.source,
                    track,
                    qualities: [...qualitiesOf(track.source)],
                });
            }
            continue;
        }

        groups.set(key, {
            primary: track,
            candidates: [{source: track.source, track, qualities: [...qualitiesOf(track.source)]}],
        });
    }

    return [...groups.values()].map(({primary, candidates}) => ({
        ...primary,
        id: `song:${trackGroupKey(primary)}`,
        candidates,
        sourceCount: candidates.length,
    }));
}

/** 按音源偏好顺序排序候选（未出现在偏好里的保持原顺序排在最后） */
export function sortCandidates(
    candidates: TrackCandidate[],
    preference: readonly string[],
): TrackCandidate[] {
    if (preference.length === 0) return candidates;
    return [...candidates].sort((a, b) => {
        const ai = preference.indexOf(a.source);
        const bi = preference.indexOf(b.source);
        return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
    });
}

/**
 * 在聚合结果上按音源筛选：
 * 只保留该音源有候选的歌曲，并把候选收敛成该音源这一条。
 */
export function filterGroupsBySource(
    groups: GroupedTrack[],
    sourceId: string,
): GroupedTrack[] {
    if (!sourceId || sourceId === 'all') return groups;

    return groups.flatMap((group) => {
        const candidates = group.candidates.filter((candidate) => candidate.source === sourceId);
        if (candidates.length === 0) return [];
        const primary = candidates[0].track;
        return [{...group, ...primary, id: group.id, candidates, sourceCount: 1}];
    });
}
