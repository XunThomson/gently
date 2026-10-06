import styles from './ChartList.module.css';
import { grad } from '../../../utils/helpers';
import type { NowPlaying, SongRow } from '../../../types';

interface Props {
    rows: SongRow[];
    /** 用于让渐变随日期变化 */
    seed: number;
    current: NowPlaying | null;
    onSelect: (song: SongRow, gradient: string) => void;
}

export default function ChartList({ rows, seed, current, onSelect }: Props) {
    if (rows.length === 0) {
        return (
            <div className={styles.empty}>
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
                    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
                    <path
                        d="M20 20l-3.2-3.2"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                    />
                </svg>
                <h4>没有找到匹配的歌曲</h4>
                <p>换个关键词试试</p>
            </div>
        );
    }

    return (
        <div className={styles.list}>
            {rows.map((song, i) => {
                const gradient = grad(i + (seed % 5));
                const isPlaying =
                    !!current && current.title === song.title && current.artist === song.artist;

                return (
                    <div
                        key={`${song.title}-${song.artist}-${i}`}
                        className={`${styles.row}${isPlaying ? ` ${styles.playing}` : ''}`}
                        onClick={() => onSelect(song, gradient)}
                    >
                        <div className={styles.rank}>{i + 1}</div>

                        <div className={styles.cov} style={{ background: gradient }}>
                            {isPlaying ? (
                                <div className={styles.playingBars}>
                                    <i />
                                    <i />
                                    <i />
                                </div>
                            ) : (
                                '♪'
                            )}
                        </div>

                        <div className={styles.meta}>
                            <div className={styles.title}>{song.title}</div>
                            <div className={styles.artist}>{song.artist}</div>
                        </div>

                        <div className={styles.album}>{song.album}</div>

                        <div className={styles.heat}>
                            <div className={styles.heatBar}>
                                <i style={{ width: `${song.heat}%` }} />
                            </div>
                            <span className={styles.heatNum}>{song.heat}</span>
                        </div>

                        <div className={styles.dur}>{song.dur}</div>
                    </div>
                );
            })}
        </div>
    );
}