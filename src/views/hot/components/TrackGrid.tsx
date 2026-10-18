import {useTranslation} from 'react-i18next';
import {EmptyState} from '../../../components/ui/empty-state';
import {IconClose, IconMusic, IconPause, IconPlay} from '../../../components/ui/icon';
import {ReasonChip} from '../../../components/ui/reason-chip';
import type {RecommendationReason, Track} from '../../../types';
import {trackCoverStyle} from '../../../utils/cover';
import styles from './TrackGrid.module.css';

export interface TrackGridProps {
    tracks: Track[];
    loading?: boolean;
    /** 当前曲目 id，用于高亮与播放/暂停图标 */
    currentId?: string | null;
    playing?: boolean;
    /** 可选：个性化推荐理由，传了就在卡片上显示「为什么推荐」 */
    reasonOf?: (track: Track) => RecommendationReason | undefined;
    /**
     * 可选：推荐场景的「不感兴趣」。传了才显示这个按钮——
     * 搜索结果不是推荐，不该出现「不感兴趣」（那会让人以为搜索被过滤了）。
     */
    onDislike?: (track: Track) => void;
    onSelect: (track: Track) => void;
    /** 空态文案（推荐页与搜索页语境不同：这里传推荐专用的） */
    emptyTitleKey?: string;
    emptyHintKey?: string;
}

/**
 * 封面卡片网格：推荐列表与搜索结果共用。
 *
 * 卡片是「容器 + 主按钮（点播）+ 可选次按钮（不感兴趣）」而不是一个整块 `<button>`：
 * 按钮里套按钮是无效 HTML（键盘与读屏都会错乱），因此主次操作必须并列。
 */
export function TrackGrid({
    tracks,
    loading = false,
    currentId,
    playing = false,
    reasonOf,
    onDislike,
    onSelect,
    emptyTitleKey = 'page.hot.searchEmptyTitle',
    emptyHintKey = 'page.hot.searchEmptyHint',
}: TrackGridProps) {
    const {t} = useTranslation();

    if (!loading && tracks.length === 0) {
        return (
            <EmptyState
                icon={<IconMusic size={30}/>}
                title={t(emptyTitleKey)}
                hint={t(emptyHintKey)}
            />
        );
    }

    return (
        <div className={styles.grid}>
            {tracks.map((track) => {
                const isCurrent = currentId === track.id;
                const reason = reasonOf?.(track);

                return (
                    <div
                        key={track.id}
                        className={`${styles.card}${isCurrent ? ` ${styles.cardActive}` : ''}`}
                    >
                        <button
                            type="button"
                            className={styles.cardMain}
                            onClick={() => onSelect(track)}
                        >
                            <span className={styles.cover} style={trackCoverStyle(track)}>
                                <span className={styles.initial}>{track.title.slice(0, 1)}</span>
                                <span className={`${styles.play}${isCurrent ? ` ${styles.playVisible}` : ''}`}>
                                    {isCurrent && playing ? <IconPause size={12}/> : <IconPlay size={12}/>}
                                </span>
                            </span>
                            <span className={styles.title}>{track.title}</span>
                            <span className={styles.artist}>{track.artist}</span>
                            {reason && (
                                <span className={styles.reason}>
                                    <ReasonChip reason={reason}/>
                                </span>
                            )}
                        </button>

                        {onDislike && (
                            <button
                                type="button"
                                className={styles.dislike}
                                title={t('recommend.dislike')}
                                aria-label={t('recommend.dislike')}
                                onClick={() => onDislike(track)}
                            >
                                <IconClose size={12}/>
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

export default TrackGrid;
