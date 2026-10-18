import type {CSSProperties} from 'react';
import styles from './desktop-lyrics.module.css';

/** 字号缩放仍以主题 token 为基准（不把像素值写进组件） */
export function scaleStyle(token: string, scale: number): CSSProperties {
    return {fontSize: `calc(var(${token}) * ${scale})`};
}

export interface LyricsLineViewProps {
    line: string;
    translation?: string;
    /** 逐字展开进度（0~1）；只有 `sweep` 为 true 时用 */
    progress: number;
    sweep: boolean;
    scale: number;
}

/**
 * 当前行的渲染（**拆出来为了可测**：桌面歌词窗口自己监听事件，冒烟里没法注入载荷）。
 *
 * 逐字展开的做法是**两层同一段文字**：底层弱化（还没唱到），上层用 `clip-path` 按进度
 * 从左往右裁出来。比逐字符包 `<span>` 简单得多，也不需要每个字的时长（LRC 只有行级时间轴）。
 */
export function LyricsLineView({line, translation, progress, sweep, scale}: LyricsLineViewProps) {
    return (
        <>
            {sweep ? (
                <p className={styles.line} style={scaleStyle('--font-size-3xl', scale)}>
                    <span className={styles.lineIdle}>{line}</span>
                    <span
                        className={styles.lineSweep}
                        style={{clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)`}}
                        aria-hidden="true"
                    >
                        {line}
                    </span>
                </p>
            ) : (
                <p className={styles.line} style={scaleStyle('--font-size-3xl', scale)}>
                    {line}
                </p>
            )}
            {translation && (
                <p className={styles.translation} style={scaleStyle('--font-size-base', scale)}>
                    {translation}
                </p>
            )}
        </>
    );
}

export default LyricsLineView;
