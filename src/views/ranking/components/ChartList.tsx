import {EmptyState} from '../../../components/ui/empty-state';
import {useTranslation} from 'react-i18next';
import {IconMusic} from '../../../components/ui/icon';
import type {RankedTrack} from '../../../utils/track';
import styles from './ChartList.module.css';

export interface ChartListProps {
    rows: RankedTrack[];
    /** 正在播放的曲目标识（`title|artist`） */
    currentTitle: string | null;
    loading?: boolean;
    onSelect: (track: RankedTrack) => void;
}

/** 榜单列表：名次 / 封面 / 歌曲信息 / 专辑 / 热度 / 时长。 */
export function ChartList({rows, currentTitle, loading = false, onSelect}: ChartListProps) {
    const {t} = useTranslation();

    if (!loading && rows.length === 0) {
        return <EmptyState icon={<IconMusic size={30}/>} title={t('page.ranking.emptyTitle')} hint={t('page.ranking.emptyHint')}/>;
    }

    return (
        <div className={styles.list}>
            {rows.map((track, i) => {
                const playing = currentTitle === `${track.title}|${track.artist}`;

                return (
                    <div
                        key={track.id}
                        className={`${styles.row}${playing ? ` ${styles.playing}` : ''}`}
                        onClick={() => onSelect(track)}
                    >
                        <div className={styles.rank}>{i + 1}</div>

                        <div className={styles.cover} style={{background: track.gradient}}>
                            {playing ? (
                                <div className={styles.playingBars}>
                                    <i/>
                                    <i/>
                                    <i/>
                                </div>
                            ) : (
                                '♪'
                            )}
                        </div>

                        <div className={styles.meta}>
                            <div className={styles.title}>{track.title}</div>
                            <div className={styles.artist}>{track.artist}</div>
                        </div>

                        <div className={styles.album}>{track.album}</div>

                        <div className={styles.heat}>
                            <div className={styles.heatBar}>
                                <i style={{width: `${track.heat}%`}}/>
                            </div>
                            <span className={styles.heatNum}>{track.heat}</span>
                        </div>

                        <div className={styles.duration}>{track.duration}</div>
                    </div>
                );
            })}
        </div>
    );
}

export default ChartList;
