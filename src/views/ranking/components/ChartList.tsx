import {EmptyState} from '../../../components/ui/empty-state';
import {DownloadMark} from '../../../components/ui/download-mark';
import {useTranslation} from 'react-i18next';
import {IconMusic} from '../../../components/ui/icon';
import type {Track} from '../../../types';
import {trackCoverStyle} from '../../../utils/cover';
import styles from './ChartList.module.css';

export interface ChartListProps {
    rows: Track[];
    /** 正在播放的曲目标识（`title|artist`） */
    currentTitle: string | null;
    loading?: boolean;
    onSelect: (track: Track) => void;
}

/**
 * 榜单/分类列表：名次 / 封面 / 歌曲信息 / 专辑 / 时长。
 *
 * 名次用**源给的顺序**（`catalog.topList` 返回的顺序就是榜单顺序，核心不重排），
 * 因此这里不做任何排序，也不显示「热度」——真实源不返回热度，编一个只会误导。
 */
export function ChartList({rows, currentTitle, loading = false, onSelect}: ChartListProps) {
    const {t} = useTranslation();

    if (!loading && rows.length === 0) {
        return (
            <EmptyState
                icon={<IconMusic size={30}/>}
                title={t('page.ranking.emptyTitle')}
                hint={t('page.ranking.emptyHint')}
            />
        );
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

                        <div
                            className={styles.cover}
                            style={trackCoverStyle(track)}
                        >
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
                            <div className={styles.title}>
                                {track.title}
                                {/* 榜单也是业务列表：下过没有要能一眼看到（与 DataTable 的标题列一致） */}
                                <DownloadMark track={track}/>
                            </div>
                            <div className={styles.artist}>{track.artist}</div>
                        </div>

                        <div className={styles.album}>{track.album}</div>

                        <div className={styles.duration}>{track.duration}</div>
                    </div>
                );
            })}
        </div>
    );
}

export default ChartList;
