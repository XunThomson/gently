import {useTranslation} from 'react-i18next';
import {EmptyState} from '../../../components/ui/empty-state';
import {IconMusic, IconPause, IconPlay} from '../../../components/ui/icon';
import type {Track} from '../../../types';
import styles from './TrackGrid.module.css';

export interface TrackGridProps {
    tracks: Track[];
    loading?: boolean;
    /** 当前曲目 id，用于高亮与播放/暂停图标 */
    currentId?: string | null;
    playing?: boolean;
    onSelect: (track: Track) => void;
}

/** 封面卡片网格：推荐列表与搜索结果共用。 */
export function TrackGrid({tracks, loading = false, currentId, playing = false, onSelect}: TrackGridProps) {
    const {t} = useTranslation();

    if (!loading && tracks.length === 0) {
        return (
            <EmptyState
                icon={<IconMusic size={30}/>}
                title={t('page.hot.emptyTitle')}
                hint={t('page.hot.emptyHint')}
            />
        );
    }

    return (
        <div className={styles.grid}>
            {tracks.map((track) => {
                const isCurrent = currentId === track.id;

                return (
                    <button
                        key={track.id}
                        type="button"
                        className={`${styles.card}${isCurrent ? ` ${styles.cardActive}` : ''}`}
                        onClick={() => onSelect(track)}
                    >
                        <span className={styles.cover} style={{background: track.gradient}}>
                            <span className={styles.initial}>{track.title.slice(0, 1)}</span>
                            <span className={`${styles.play}${isCurrent ? ` ${styles.playVisible}` : ''}`}>
                                {isCurrent && playing ? <IconPause size={12}/> : <IconPlay size={12}/>}
                            </span>
                        </span>
                        <span className={styles.title}>{track.title}</span>
                        <span className={styles.artist}>{track.artist}</span>
                    </button>
                );
            })}
        </div>
    );
}

export default TrackGrid;
