import {forwardRef, useEffect, useMemo, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import {IconChevronDown, IconClose, IconTrash} from '../../ui/icon';
import {useActions, usePlayerState} from '../../../store';
import type {Track} from '../../../types';
import styles from './Panel.module.css';

/** 行所在分区：正在播放 / 接下来播放 / 已播放 */
type RowKind = 'current' | 'upNext' | 'played';

interface RowHandlers {
    onToggle: (track: Track) => void;
    onMove: (trackId: string, offset: -1 | 1) => void;
    onRemove: (trackId: string) => void;
}

interface QueueRowProps extends RowHandlers {
    track: Track;
    /** 展示用的序号（队列内的真实位置） */
    order: number;
    kind: RowKind;
    canMoveUp: boolean;
    canMoveDown: boolean;
    /** 正在播放的那一行用于首次打开时滚动定位 */
    scrollTarget?: boolean;
}

/**
 * 队列行：整行是一个 <button>（点击 = 切歌 / 点当前曲目 = 播放暂停），
 * 行内图标操作是它的**兄弟节点**而不是子节点，
 * 因此既不会出现 button 嵌套 button，也不会有「点操作顺带触发整行点击」的问题；
 * 每个操作仍在 onClick 里 stopPropagation()，双保险。
 */
const QueueRow = forwardRef<HTMLLIElement, QueueRowProps>(function QueueRow(
    {track, order, kind, canMoveUp, canMoveDown, scrollTarget, onToggle, onMove, onRemove},
    ref,
) {
    const {t} = useTranslation();
    const active = kind === 'current';

    return (
        <li
            ref={scrollTarget ? ref : undefined}
            className={`${styles.listItem}${active ? ` ${styles.listItemActive}` : ''}`}
        >
            <button
                type="button"
                className={`${styles.item}${active ? ` ${styles.itemActive}` : ''}${
                    kind === 'played' ? ` ${styles.itemPlayed}` : ''
                }`}
                aria-current={active ? 'true' : undefined}
                onClick={() => onToggle(track)}
            >
                <span className={styles.index}>{order}</span>
                <span className={styles.itemMain}>
                    <span className={styles.itemTitle}>{track.title}</span>
                    <span className={styles.itemArtist}>{track.artist}</span>
                </span>
                <span className={styles.duration}>{track.duration}</span>
            </button>

            {!active && (
                <span className={styles.rowActions}>
                    <button
                        type="button"
                        className={styles.actionButton}
                        disabled={!canMoveUp}
                        aria-label={t('player.queueMoveUp')}
                        title={t('player.queueMoveUp')}
                        onClick={(event) => {
                            event.stopPropagation();
                            onMove(track.id, -1);
                        }}
                    >
                        <IconChevronDown size={14} className={styles.iconUp}/>
                    </button>
                    <button
                        type="button"
                        className={styles.actionButton}
                        disabled={!canMoveDown}
                        aria-label={t('player.queueMoveDown')}
                        title={t('player.queueMoveDown')}
                        onClick={(event) => {
                            event.stopPropagation();
                            onMove(track.id, 1);
                        }}
                    >
                        <IconChevronDown size={14}/>
                    </button>
                    <button
                        type="button"
                        className={styles.actionButton}
                        aria-label={t('player.queueRemove')}
                        title={t('player.queueRemove')}
                        onClick={(event) => {
                            event.stopPropagation();
                            onRemove(track.id);
                        }}
                    >
                        <IconTrash size={14}/>
                    </button>
                </span>
            )}
        </li>
    );
});

/**
 * 播放列表抽屉：分段展示「正在播放 / 接下来播放 / 已播放」。
 * - 点击行只切歌，**不关闭抽屉**；
 * - 打开时把正在播放的行滚到列表中部；
 * - onClose 仅由右上角关闭按钮触发。
 */
export function QueuePanel({onClose}: { onClose: () => void }) {
    const {t} = useTranslation();
    const {queue, index, current} = usePlayerState();
    const {play, playOrToggle, removeFromQueue, moveInQueue, clearQueue} = useActions().player;
    const currentRowRef = useRef<HTMLLIElement | null>(null);

    /* 正在播放 = queue[index]（回退到 current）；接下来 = index 之后；已播放 = index 之前 */
    const nowPlaying = useMemo<Track | null>(
        () => queue[index] ?? current ?? null,
        [queue, index, current],
    );
    const upNext = useMemo(() => queue.slice(index + 1), [queue, index]);
    const played = useMemo(() => (index > 0 ? queue.slice(0, index) : []), [queue, index]);

    /* 打开抽屉时把当前曲目滚到可视区中部（SSR 下 scrollIntoView 不存在，需守卫） */
    useEffect(() => {
        const row = currentRowRef.current;
        if (row && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({block: 'center'});
        }
    }, []);

    const toggle = (track: Track) => {
        if (nowPlaying && track.id === nowPlaying.id) playOrToggle(track, queue);
        else play(track, queue);
    };

    const handlers: RowHandlers = {
        onToggle: toggle,
        onMove: moveInQueue,
        onRemove: removeFromQueue,
    };

    const empty = !nowPlaying && upNext.length === 0 && played.length === 0;
    const total = queue.length || (nowPlaying ? 1 : 0);

    return (
        <div className={styles.panel} role="dialog" aria-label={t('player.queue')}>
            <div className={styles.head}>
                <span className={styles.title}>{t('player.queue')}</span>
                <span className={styles.count}>{total}</span>

                <div className={styles.headTools}>
                    <button
                        type="button"
                        className={styles.headAction}
                        disabled={upNext.length === 0}
                        onClick={() => clearQueue()}
                    >
                        {t('player.queueClear')}
                    </button>
                    <button
                        type="button"
                        className={styles.headIcon}
                        aria-label={t('toolbar.close')}
                        title={t('toolbar.close')}
                        onClick={() => onClose()}
                    >
                        <IconClose size={14}/>
                    </button>
                </div>
            </div>

            {empty ? (
                <p className={styles.empty}>{t('player.queueEmpty')}</p>
            ) : (
                <div className={styles.listScroll}>
                    {nowPlaying && (
                        <section className={styles.group}>
                            <p className={styles.groupLabel}>{t('player.nowPlayingTag')}</p>
                            <ul className={styles.list}>
                                <QueueRow
                                    ref={currentRowRef}
                                    scrollTarget
                                    track={nowPlaying}
                                    order={index >= 0 ? index + 1 : 1}
                                    kind="current"
                                    canMoveUp={false}
                                    canMoveDown={false}
                                    {...handlers}
                                />
                            </ul>
                        </section>
                    )}

                    {upNext.length > 0 && (
                        <section className={styles.group}>
                            <p className={styles.groupLabel}>{t('player.queueUpNext')}</p>
                            <ul className={styles.list}>
                                {upNext.map((track, offset) => (
                                    <QueueRow
                                        key={track.id}
                                        track={track}
                                        order={index + offset + 2}
                                        kind="upNext"
                                        canMoveUp={offset > 0}
                                        canMoveDown
                                        {...handlers}
                                    />
                                ))}
                            </ul>
                        </section>
                    )}

                    {played.length > 0 && (
                        <section className={styles.group}>
                            <p className={styles.groupLabel}>{t('player.queuePlayed')}</p>
                            <ul className={styles.list}>
                                {played.map((track, offset) => (
                                    <QueueRow
                                        key={track.id}
                                        track={track}
                                        order={offset + 1}
                                        kind="played"
                                        canMoveUp={offset > 0}
                                        canMoveDown
                                        {...handlers}
                                    />
                                ))}
                            </ul>
                        </section>
                    )}
                </div>
            )}
        </div>
    );
}

export default QueuePanel;
