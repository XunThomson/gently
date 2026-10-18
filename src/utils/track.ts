import type {GroupedTrack, Track, TrackCandidate, TrackQuality} from '../types';

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
        /**
         * 封面（与渐变占位）**在各候选之间取第一个非空的**。
         *
         * 为什么：同一首歌常被多个源收录，而「哪个源排前面」取决于音源优先级。视频站的条目
         * 几乎都带封面（视频封面就是专辑封面），音乐站的搜索接口却常常不给（实测网易云
         * `/api/search/get` 的 `album.picUrl` 是空串）。只认 primary 的话，同一首歌会
         * 「有时有图、有时是色块」，取决于哪个源排在前面（R73 用户报的「封面大多数都有」）。
         */
        artwork: firstNonEmpty([primary.artwork, ...candidates.map((item) => item.track.artwork)]),
        gradient: firstNonEmpty([primary.gradient, ...candidates.map((item) => item.track.gradient)]) ?? '',
        candidates,
        sourceCount: candidates.length,
    }));
}

/** 第一个非空字符串（保留顺序，「主条目 → 候选」兜底取值用） */
export function firstNonEmpty(values: (string | undefined)[]): string | undefined {
    return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
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
