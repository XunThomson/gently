import {useTranslation} from 'react-i18next';
import type {RecommendedTrack} from '../../../types';
import {trackCoverStyle} from '../../../utils/cover';
import styles from './SimilarList.module.css';

export interface SimilarListProps {
    tracks: RecommendedTrack[];
    /** 正在播放的曲目 id（与主列表的 `activeRowKey` 同一口径） */
    currentId: string | null;
    onSelect: (track: RecommendedTrack) => void;
}

/**
 * 相似推荐列表（专辑/歌单详情页底部）。
 *
 * 刻意比主列表**轻**：详情页的主体是这张专辑/歌单，相似推荐是「下一步去哪」的提示，
 * 因此不排名次、不显示专辑列，只保留封面、曲目、歌手与理由。
 *
 * 数据只可能来自核心（`recommend.similar`）——没有核心就没有这套算法，
 * 浏览器预览下拿到空数组，视图直接不渲染这一块（不编一份 mock 打分）。
 */
export function SimilarList({tracks, currentId, onSelect}: SimilarListProps) {
    const {t} = useTranslation();

    if (tracks.length === 0) return null;

    return (
        <ul className={styles.list}>
            {tracks.map((track) => {
                const playing = track.id === currentId;

                return (
                    <li key={track.id}>
                        <button
                            type="button"
                            className={`${styles.row}${playing ? ` ${styles.playing}` : ''}`}
                            onClick={() => onSelect(track)}
                        >
                            <span
                                className={styles.cover}
                                style={trackCoverStyle(track)}
                            >
                                {playing ? '❚❚' : '♪'}
                            </span>
                            <span className={styles.meta}>
                                <span className={styles.title}>{track.title}</span>
                                <span className={styles.artist}>{track.artist}</span>
                            </span>
                            {/* 推荐理由：可解释是这个算法的一部分，不能只给结果 */}
                            <span className={styles.reason}>
                                {reasonText(t, track)}
                            </span>
                            <span className={styles.duration}>{track.duration}</span>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}

/** 把结构化理由（`{kind, value}`）翻成一句人话——与推荐页用同一套 i18n 键。 */
function reasonText(
    t: ReturnType<typeof useTranslation>['t'],
    track: RecommendedTrack,
): string {
    switch (track.reason.kind) {
        case 'artist':
            return t('recommend.reasonArtist', {name: track.reason.value});
        case 'tag':
            return t('recommend.reasonTag', {name: track.reason.value});
        case 'similar':
            return t('recommend.reasonSimilar', {name: track.reason.value});
        default:
            return t('recommend.reasonTrending');
    }
}

export default SimilarList;
