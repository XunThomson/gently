import {useCallback, useRef, useState, type KeyboardEvent, type PointerEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {appConfig} from '../../../config/app.config';
import {fmt} from '../../../utils/helpers';
import styles from './SeekBar.module.css';

const SEEK_STEP = appConfig.player.seekStepSec;

export interface SeekBarProps {
    elapsed: number;
    duration: number;
    /** 焦点皮肤：default | glow | ring（来自 theme.config.json） */
    skin?: string;
    onSeek: (seconds: number) => void;
}

/**
 * bilibili 式进度条：贴在播放条顶边。
 *
 * - 默认只显示细进度线，**不显示焦点**；
 * - 鼠标悬浮 / 键盘聚焦 / 拖拽时进度条放大并显示焦点；
 * - 焦点皮肤由主题配置 `components.playerBar.progressThumbSkin` 决定；
 * - 悬浮或拖拽时在指针位置显示时间预览。
 */
export function SeekBar({elapsed, duration, skin = 'default', onSeek}: SeekBarProps) {
    const {t} = useTranslation();
    const barRef = useRef<HTMLDivElement>(null);
    const [dragRatio, setDragRatio] = useState<number | null>(null);
    const [hoverRatio, setHoverRatio] = useState<number | null>(null);

    const ratioFrom = useCallback((clientX: number): number => {
        const rect = barRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return 0;
        return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    }, []);

    const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
        if (duration <= 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragRatio(ratioFrom(e.clientX));
    };

    const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
        const ratio = ratioFrom(e.clientX);
        setHoverRatio(ratio);
        if (dragRatio !== null) setDragRatio(ratio);
    };

    const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
        if (dragRatio === null) return;
        onSeek(dragRatio * duration);
        setDragRatio(null);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        /* 触屏松手后不会再有 `pointerleave`，时间预览会一直挂在屏幕上；
           鼠标保持悬浮预览（移动即恢复），所以只清非鼠标指针 */
        if (e.pointerType !== 'mouse') setHoverRatio(null);
    };

    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (duration <= 0) return;
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            onSeek(elapsed - SEEK_STEP);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            onSeek(elapsed + SEEK_STEP);
        }
    };

    const ratio = dragRatio ?? hoverRatio;
    const percent = duration > 0 ? (dragRatio ?? elapsed / duration) * 100 : 0;
    const previewTime = ratio !== null && duration > 0 ? ratio * duration : null;

    return (
        <div
            ref={barRef}
            className={[styles.root, dragRatio !== null ? styles.dragging : '']
                .filter(Boolean)
                .join(' ')}
            data-skin={skin}
            role="slider"
            tabIndex={0}
            aria-label={t('column.progress')}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(elapsed)}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={() => setHoverRatio(null)}
            onKeyDown={handleKeyDown}
        >
            <div className={styles.track}>
                <i className={styles.fill} style={{width: `${percent}%`}}/>
            </div>

            <span className={styles.thumb} style={{left: `${percent}%`}}/>

            {previewTime !== null && (
                <span className={styles.preview} style={{left: `${(ratio ?? 0) * 100}%`}}>
                    {fmt(previewTime)}
                </span>
            )}
        </div>
    );
}

export default SeekBar;
