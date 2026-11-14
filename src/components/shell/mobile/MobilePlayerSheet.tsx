import {createPortal} from 'react-dom';
import {useTranslation} from 'react-i18next';
import {useBackToClose} from '../../../hooks/useBackToClose';
import {usePlayerState} from '../../../store';
import {IconClose} from '../../ui/icon';
import {ActionsPanel, QueuePanel} from '../player-bar';
import {PlaybackModes} from './PlaybackModes';
import {PlaybackOptions} from './PlaybackOptions';
import styles from './MobilePlayerSheet.module.css';

/**
 * 手机播放条的功能抽屉（最后一个功能位）。
 *
 * 手机播放条本身只放 4 个功能位：收藏 / 播放暂停 / 下一首 / 更多。
 * 其余功能（上一首、随机、循环、定时关闭、音源、音质、队列、下载、加入歌单）
 * 全部收进这里；歌曲详情页（歌词页）里也能用同一组播放模式。
 */
export function MobilePlayerSheet({onClose}: {onClose: () => void}) {
    const {t} = useTranslation();
    const {current, detail} = usePlayerState();

    useBackToClose(true, onClose);

    if (typeof document === 'undefined') return null;

    const art = detail ?? current;

    return createPortal(
        <div className={styles.scrim} onClick={onClose}>
            <div
                className={styles.sheet}
                role="dialog"
                aria-label={t('player.moreFunctions')}
                onClick={(event) => event.stopPropagation()}
            >
                <div className={styles.grabber} aria-hidden="true">
                    <div className={styles.grabberBar}/>
                </div>

                <div className={styles.header}>
                    <span className={styles.heading}>
                        <span className={styles.title}>{art?.title ?? t('player.notPlaying')}</span>
                        <span className={styles.subtitle}>{art?.artist ?? ''}</span>
                    </span>
                    <button
                        type="button"
                        className={styles.close}
                        aria-label={t('toolbar.close')}
                        onClick={onClose}
                    >
                        <IconClose size={16}/>
                    </button>
                </div>

                <PlaybackModes showTransport/>

                <section className={styles.section}>
                    <h3 className={styles.sectionTitle}>{t('player.playbackSettings')}</h3>
                    <PlaybackOptions/>
                </section>

                <section className={styles.section}>
                    <ActionsPanel inline onClose={onClose}/>
                </section>

                <section className={styles.section}>
                    <QueuePanel inline onClose={onClose}/>
                </section>
            </div>
        </div>,
        document.body,
    );
}

export default MobilePlayerSheet;
