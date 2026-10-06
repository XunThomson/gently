import {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {useActions, usePlayerState} from '../../../store';
import styles from './Panel.module.css';

/** 播放列表抽屉：当前曲目 + 队列，点击即切换播放。 */
export function QueuePanel({onClose}: { onClose: () => void }) {
    const {t} = useTranslation();
    const {current, queue} = usePlayerState();
    const {play, playOrToggle} = useActions().player;

    /* 当前曲目可能不在队列里（例如从推荐卡直接播放），需要补到列表头部 */
    const list = useMemo(() => {
        if (!current) return queue;
        return queue.some((track) => track.id === current.id) ? queue : [current, ...queue];
    }, [queue, current]);

    return (
        <div className={styles.panel} role="dialog" aria-label={t('player.queue')}>
            <div className={styles.head}>
                <span className={styles.title}>{t('player.queue')}</span>
                <span className={styles.count}>{list.length}</span>
            </div>

            {list.length === 0 ? (
                <p className={styles.empty}>{t('player.queueEmpty')}</p>
            ) : (
                <ul className={styles.list}>
                    {list.map((track, index) => {
                        const active = current?.id === track.id;

                        return (
                            <li key={`${track.id}-${index}`}>
                                <button
                                    type="button"
                                    className={`${styles.item}${active ? ` ${styles.itemActive}` : ''}`}
                                    onClick={() => {
                                        if (active) playOrToggle(track, list);
                                        else play(track, list);
                                        onClose();
                                    }}
                                >
                                    <span className={styles.index}>{index + 1}</span>
                                    <span className={styles.itemMain}>
                                        <span className={styles.itemTitle}>{track.title}</span>
                                        <span className={styles.itemArtist}>
                                            {track.artist}
                                            {active && (
                                                <span className={styles.tag}>
                                                    {t('player.nowPlayingTag')}
                                                </span>
                                            )}
                                        </span>
                                    </span>
                                    <span className={styles.duration}>{track.duration}</span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

export default QueuePanel;
