import {useTranslation} from 'react-i18next';
import type {LyricLine} from '../../../types';
import {activeLyricIndex, miniLyricSlots} from '../../../utils/lyrics';
import styles from './MiniLyrics.module.css';

export interface MiniLyricsProps {
    lines: LyricLine[];
    elapsed: number;
    onSeek: (time: number) => void;
    className?: string;
}

/**
 * 迷你播放器的三行歌词窗口。
 *
 * 不滚动、不渲染整份歌词：固定「上一行 / 当前行 / 下一行」三个槽，
 * 当前行始终在中间；首尾用空槽占位。点击可见行仍然跳转。
 */
export function MiniLyrics({lines, elapsed, onSeek, className}: MiniLyricsProps) {
    const {t} = useTranslation();
    const activeIndex = activeLyricIndex(lines, elapsed);

    if (lines.length === 0) {
        return (
            <div className={[styles.empty, className].filter(Boolean).join(' ')}>
                {t('page.nowPlaying.noLyrics')}
            </div>
        );
    }

    const slots = miniLyricSlots(lines, activeIndex);

    return (
        <div className={[styles.root, className].filter(Boolean).join(' ')} role="list">
            {slots.map((slot, slotIndex) => {
                if (!slot.line) {
                    return <span key={`empty-${slotIndex}`} className={styles.emptySlot} aria-hidden="true"/>;
                }
                const active = slot.index === activeIndex;
                return (
                    <button
                        key={`${slot.index}-${slot.line.time}`}
                        type="button"
                        role="listitem"
                        data-active={active ? 'true' : 'false'}
                        aria-current={active ? 'true' : undefined}
                        className={styles.line}
                        onClick={() => onSeek(slot.line!.time)}
                    >
                        {slot.line.text}
                        {slot.line.translation && (
                            <span className={styles.translation}>{slot.line.translation}</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}

export default MiniLyrics;
