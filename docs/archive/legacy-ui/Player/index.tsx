// src/components/Player/Player.tsx
import { useEffect, useRef, useState } from 'react';
import styles from './Player.module.css';
import { fmt } from '../../utils/helpers';
import type { NowPlaying } from '../../types';

interface Props {
    current: NowPlaying | null;
    playing: boolean;
    onToggle: () => void;
    onEnded: () => void;
}

export default function Player({ current, playing, onToggle, onEnded }: Props) {
    const [total, setTotal] = useState(0);
    const [elapsed, setElapsed] = useState(0);

    const elapsedRef = useRef(0);
    const onEndedRef = useRef(onEnded);
    onEndedRef.current = onEnded;

    /* 切歌 → 重置进度 */
    useEffect(() => {
        if (!current) return;
        elapsedRef.current = 0;
        setElapsed(0);
        setTotal(180 + Math.floor(Math.random() * 120));
    }, [current]);

    /* 秒针 */
    useEffect(() => {
        if (!playing || total === 0) return;

        const id = window.setInterval(() => {
            elapsedRef.current += 1;
            if (elapsedRef.current >= total) {
                elapsedRef.current = 0;
                setElapsed(0);
                onEndedRef.current();
            } else {
                setElapsed(elapsedRef.current);
            }
        }, 1000);

        return () => window.clearInterval(id);
    }, [playing, total]);

    const percent = total > 0 ? (elapsed / total) * 100 : 0;

    return (
        <div className={styles.player}>
            <div className={styles.left}>
                <div
                    className={styles.cover}
                    style={current ? { background: current.gradient } : undefined}
                >
                    {current ? current.title.slice(0, 1) : '♪'}
                </div>
                <div className={styles.info}>
                    <div className={styles.title}>{current ? current.title : '未在播放'}</div>
                    <div className={styles.artist}>{current ? current.artist : '选择一首歌曲开始'}</div>
                </div>
            </div>

            <div className={styles.center}>
                <div className={styles.controls}>
                    <button className={styles.ctrl} title="上一首">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M7 6h2v12H7zM19 6v12l-9-6z" />
                        </svg>
                    </button>

                    <button className={styles.ctrlMain} title="播放/暂停" onClick={onToggle}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            {playing ? (
                                <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
                            ) : (
                                <path d="M7 4.5v15l13-7.5z" />
                            )}
                        </svg>
                    </button>

                    <button className={styles.ctrl} title="下一首">
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M15 6h2v12h-2zM5 6v12l9-6z" />
                        </svg>
                    </button>
                </div>

                <div className={styles.progress}>
                    <span className={styles.time}>{fmt(elapsed)}</span>
                    <div className={styles.bar}>
                        <i style={{ width: `${percent}%` }} />
                    </div>
                    <span className={styles.time}>{total ? fmt(total) : '0:00'}</span>
                </div>
            </div>

            <div className={styles.right}>
                <button className={styles.iconBtn} title="循环模式">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                        <path
                            d="M17 2l3 3-3 3"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                        <path
                            d="M20 5H8a4 4 0 0 0-4 4v1"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                        />
                        <path
                            d="M7 22l-3-3 3-3"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                        <path
                            d="M4 19h12a4 4 0 0 0 4-4v-1"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                        />
                    </svg>
                </button>

                <button className={styles.iconBtn} title="音量">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                        <path
                            d="M4 9v6h4l5 4V5L8 9H4z"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinejoin="round"
                        />
                        <path
                            d="M16.5 9a4.5 4.5 0 0 1 0 6"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                        />
                    </svg>
                </button>
            </div>
        </div>
    );
}