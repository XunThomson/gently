import {memo, useCallback, useEffect, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import {appConfig} from '../../../config/app.config';
import type {LyricLine} from '../../../types';
import {activeLyricIndex} from '../../../utils/lyrics';
import {lyricsScrollStep, lyricsScrollTarget} from '../../../utils/lyricsScroll';
import styles from './Lyrics.module.css';

/**
 * 单行歌词：只有当前行变化时才重渲染。
 *
 * 播放进度 4Hz 回写，`Lyrics` 每次都会重新 map；如果每行都跟着重渲染，
 * 300 行歌词会在每次 timeupdate 时全部走一遍 reconciliation。`line` 来自
 * 稳定的数组，`onSeek` 也由调用方 useCallback 固定，memo 只在 active 翻转时更新。
 */
const LyricRow = memo(function LyricRow({
    line,
    active,
    onSeek,
}: {
    line: LyricLine;
    active: boolean;
    onSeek: (time: number) => void;
}) {
    return (
        <button
            type="button"
            role="listitem"
            data-active={active ? 'true' : 'false'}
            aria-current={active ? 'true' : undefined}
            className={styles.line}
            onClick={() => onSeek(line.time)}
        >
            {line.text}
            {line.translation && <span className={styles.translation}>{line.translation}</span>}
        </button>
    );
});

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
 * 这里只负责渲染、跟随滚动与「用户滚动时先让读者看完」。
 *
 * 与浏览器自带的 `scrollIntoView` 相比，这里用一条**可暂停的缓动**：
 * 每次把当前行滚到视口正中；用户滚轮 / 触摸 / 拖滚动条时暂停跟随 4 秒，
 * 松开后从读者停下的位置继续滑向当前行，而不是把人瞬间拽回去。
 */
export function Lyrics({lines, elapsed, onSeek, className}: LyricsProps) {
    const {t} = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<number | null>(null);
    const resumeTimerRef = useRef<number | null>(null);
    const suspendUntilRef = useRef(0);
    const linesRef = useRef(lines);
    const activeIndex = activeLyricIndex(lines, elapsed);

    const stopAnimation = useCallback(() => {
        if (frameRef.current !== null) {
            cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
        }
    }, []);

    /**
     * 把当前行缓动到视口中间。
     *
     * `smooth = false` 用于窗口尺寸变化：重排后立刻对准，不要让读者看着歌词在
     * 窗口拖动过程中一路漂。
     */
    const scrollToActive = useCallback((smooth: boolean) => {
        const container = containerRef.current;
        if (!container) return;
        const active = container.querySelector<HTMLElement>('[data-active="true"]');
        if (!active) return;

        const containerRect = container.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        const activeTop = activeRect.top - containerRect.top + container.scrollTop;
        const target = lyricsScrollTarget(activeTop, activeRect.height, container.clientHeight);
        const {followStep, followSettlePx} = appConfig.lyrics;
        const reduceMotion =
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        stopAnimation();
        if (!smooth || reduceMotion) {
            container.scrollTop = target;
            return;
        }

        const tick = () => {
            const next = lyricsScrollStep(
                container.scrollTop,
                target,
                followStep,
                followSettlePx,
            );
            container.scrollTop = next;
            if (next === target) {
                frameRef.current = null;
                return;
            }
            frameRef.current = requestAnimationFrame(tick);
        };
        frameRef.current = requestAnimationFrame(tick);
    }, [stopAnimation]);

    /* 用户主动滚动：暂停跟随，读完再回来。 */
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const suspend = () => {
            const wait = appConfig.lyrics.followSuspendMs;
            suspendUntilRef.current = Date.now() + wait;
            stopAnimation();
            if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
            resumeTimerRef.current = window.setTimeout(() => {
                resumeTimerRef.current = null;
                scrollToActive(true);
            }, wait + 80);
        };

        /* 只在目标就是滚动容器本身时暂停：点歌词行要能 seek，不能把点击当成滚动。 */
        const onPointerDown = (event: PointerEvent) => {
            if (event.target === container) suspend();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (
                event.key === 'PageUp' ||
                event.key === 'PageDown' ||
                event.key === 'Home' ||
                event.key === 'End'
            ) {
                suspend();
            }
        };

        container.addEventListener('wheel', suspend, {passive: true});
        container.addEventListener('touchmove', suspend, {passive: true});
        container.addEventListener('pointerdown', onPointerDown);
        container.addEventListener('keydown', onKeyDown);
        return () => {
            container.removeEventListener('wheel', suspend);
            container.removeEventListener('touchmove', suspend);
            container.removeEventListener('pointerdown', onPointerDown);
            container.removeEventListener('keydown', onKeyDown);
            if (resumeTimerRef.current !== null) {
                window.clearTimeout(resumeTimerRef.current);
                resumeTimerRef.current = null;
            }
        };
    }, [scrollToActive, stopAnimation]);

    /* 换歌 / 换歌词：回到顶部，清掉上一首的暂停状态。 */
    useEffect(() => {
        if (linesRef.current === lines) return;
        linesRef.current = lines;
        suspendUntilRef.current = 0;
        stopAnimation();
        if (resumeTimerRef.current !== null) {
            window.clearTimeout(resumeTimerRef.current);
            resumeTimerRef.current = null;
        }
        if (containerRef.current) containerRef.current.scrollTop = 0;
    }, [lines, stopAnimation]);

    /* 当前行变化：暂停期内不打扰读者，其余时候滑到中间。 */
    useEffect(() => {
        if (activeIndex < 0) return;
        if (Date.now() < suspendUntilRef.current) return;
        scrollToActive(true);
    }, [activeIndex, lines, scrollToActive]);

    /* 窗口尺寸变化：当前行位置整体变了，立刻对准（不做动画）。 */
    useEffect(() => {
        const container = containerRef.current;
        if (!container || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            if (Date.now() < suspendUntilRef.current) return;
            scrollToActive(false);
        });
        observer.observe(container);
        return () => observer.disconnect();
    }, [scrollToActive]);

    /* 卸载时停掉未走完的动画帧。 */
    useEffect(() => () => stopAnimation(), [stopAnimation]);

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
                <LyricRow
                    key={`${line.time}-${index}`}
                    line={line}
                    active={index === activeIndex}
                    onSeek={onSeek}
                />
            ))}
        </div>
    );
}

export default Lyrics;
