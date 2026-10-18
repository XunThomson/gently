import {useEffect, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import type {LyricLine} from '../../../types';
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
 * 高亮行 = 最后一行满足 line.time <= elapsed（findLastIndex 语义，按数组下标取最后匹配项）；
 * elapsed 早于所有行时为 -1。
 *
 * 导出是因为**桌面歌词窗口**也要用同一套高亮判断——同一算法只留一份实现。
 */
export function activeLyricIndex(lines: LyricLine[], elapsed: number): number {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].time <= elapsed) return i;
    }
    return -1;
}

/**
 * 歌词列表：纯展示组件。
 * 数据与跳转行为由调用方注入；滚动定位只在 effect 中触碰 DOM（兼容 SSR 冒烟测试）。
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
