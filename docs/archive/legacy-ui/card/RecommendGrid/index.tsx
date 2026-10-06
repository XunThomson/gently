import { useMemo } from 'react';
import styles from './RecommendGrid.module.css';
import { RECOMMENDED } from '../../../mock/base.data.mock';
import { grad, matchesQuery } from '../../../utils/helpers';
import type { NowPlaying } from '../../../types';

interface RecItem {
    title: string;
    artist: string;
    gradient: string;
}

interface Props {
    query: string;
    onSelect: (song: { title: string; artist: string }, gradient: string) => void;
}

export default function RecommendGrid({ query, onSelect }: Props) {
    const list = useMemo<RecItem[]>(
        () =>
            RECOMMENDED.map((s, i) => ({
                title: s[0],
                artist: s[1],
                gradient: grad(i + 4),
            })).filter((item) => matchesQuery(item.title, item.artist, query)),
        [query],
    );

    if (list.length === 0) {
        return (
            <section className={styles.section}>
                <div className={styles.sectionHead}>
                    <h2>
                        根据你的口味推荐 <span className={styles.sub}>基于最近收听</span>
                    </h2>
                </div>
                <div className={styles.grid}>
                    <div className={styles.empty}>
                        <h4>没有找到匹配的歌曲</h4>
                        <p>试试其他关键词</p>
                    </div>
                </div>
            </section>
        );
    }

    return (
        <section className={styles.section}>
            <div className={styles.sectionHead}>
                <h2>
                    根据你的口味推荐 <span className={styles.sub}>基于最近收听</span>
                </h2>
            </div>

            <div className={styles.grid}>
                {list.map((item) => (
                    <div
                        key={`${item.title}-${item.artist}`}
                        className={styles.card}
                        onClick={() => onSelect(item, item.gradient)}
                    >
                        <div className={styles.cover} style={{ background: item.gradient }}>
                            {item.title.slice(0, 1)}
                            <button className={styles.play} tabIndex={-1}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M7 4.5v15l13-7.5z" />
                                </svg>
                            </button>
                        </div>
                        <div className={styles.title}>{item.title}</div>
                        <div className={styles.artist}>{item.artist}</div>
                    </div>
                ))}
            </div>
        </section>
    );
}

/** 保留 NowPlaying 依赖，方便后续给卡片加“正在播放”态 */
export type { NowPlaying };