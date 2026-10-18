import {useEffect, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import type {LyricLine} from '../../../types';
import {activeLyricIndex} from '../../../utils/lyrics';
import styles from './Lyrics.module.css';

export interface LyricsProps {
    lines: LyricLine[];
    /** 当前播放位置（秒），用于计算高亮行 */
    elapsed: number;
    /** 点击某一行时跳转到该行时间点 */
    onSeek: (time: number) => void;
    className?: string;
}

/**
 * 高亮行算法在 `utils/lyrics.ts`（`activeLyricIndex`）：桌面歌词与 2.x 宠物也用它，
 * 这里只负责渲染与滚动。
 */
export function Lyrics({lines, elapsed, onSeek, className}: LyricsProps) {
    const {t} = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const activeIndex = activeLyricIndex(lines, elapsed);

    useEffect(() => {
        if (activeIndex < 0) return;
        const container = containerRef.current;
        if (!container) return;
        const active = container.querySelector('[data-active="true"]');
        if (!active || typeof active.scrollIntoView !== 'function') return;
        active.scrollIntoView({block: 'center', behavior: 'smooth'});
    }, [activeIndex]);

    if (lines.length === 0) {
        return (
            <div className={[styles.empty, className].filter(Boolean).join(' ')}>
                {t('page.nowPlaying.noLyrics')}
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            className={[styles.root, className].filter(Boolean).join(' ')}
            role="list"
        >
            {lines.map((line, index) => (
                <button
                    key={`${line.time}-${index}`}
                    type="button"
                    role="listitem"
                    data-active={index === activeIndex ? 'true' : 'false'}
                    aria-current={index === activeIndex ? 'true' : undefined}
                    className={styles.line}
                    onClick={() => onSeek(line.time)}
                >
                    {line.text}
                    {/* 译文贴在原文下方（源带翻译时才有），样式上弱一级 */}
                    {line.translation && <span className={styles.translation}>{line.translation}</span>}
                </button>
            ))}
        </div>
    );
}

export default Lyrics;
