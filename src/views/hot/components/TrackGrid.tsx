import {useTranslation} from 'react-i18next';
import {EmptyState} from '../../../components/ui/empty-state';
import {IconMusic, IconPlay} from '../../../components/ui/icon';
import type {Track} from '../../../types';
import styles from './TrackGrid.module.css';

export interface TrackGridProps {
    tracks: Track[];
    loading?: boolean;
    onSelect: (track: Track) => void;
}

/** 封面卡片网格：推荐列表与搜索结果共用。 */
export function TrackGrid({tracks, loading = false, onSelect}: TrackGridProps) {
    const {t} = useTranslation();

    if (!loading && tracks.length === 0) {
        return <EmptyState icon={<IconMusic size={30}/>} title={t('page.hot.emptyTitle')} hint={t('page.hot.emptyHint')}/>;
    }

    return (
        <div className={styles.grid}>
            {tracks.map((track) => (
                <button
                    key={track.id}
                    type="button"
                    className={styles.card}
                    onClick={() => onSelect(track)}
                >
                    <span className={styles.cover} style={{background: track.gradient}}>
                        <span className={styles.initial}>{track.title.slice(0, 1)}</span>
                        <span className={styles.play}>
                            <IconPlay size={12}/>
                        </span>
                    </span>
                    <span className={styles.title}>{track.title}</span>
                    <span className={styles.artist}>{track.artist}</span>
                </button>
            ))}
        </div>
    );
}

export default TrackGrid;
