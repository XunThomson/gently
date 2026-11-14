import {useTranslation} from 'react-i18next';
import {useActions, usePlayerState} from '../../../store';
import {SleepTimerButton} from '../../ui/sleep-timer/SleepTimerSheet';
import {IconNext, IconPause, IconPlay, IconPrev, IconRepeat, IconRepeatOne, IconShuffle} from '../../ui/icon';
import styles from './PlaybackModes.module.css';

/**
 * 移动端的播放模式与传输控制（随机 / 循环 / 播放 / 上一首 / 下一首 / 定时关闭）。
 *
 * 为什么单独抽出来：手机播放条只留 4 个功能位（最后一个还是抽屉），
 * 其余功能既要能从抽屉用，也要能在歌曲详情（歌词页）里用。共用一份实现，
 * 两处的「按下态 / 文案 / 行为」才不会再分叉。
 */
export function PlaybackModes({showTransport = false}: {showTransport?: boolean}) {
    const {t} = useTranslation();
    const {playing, repeat, shuffle, playbackError} = usePlayerState();
    const {toggle, next, prev, setRepeat, setShuffle, retryPlayback} = useActions().player;

    const repeatLabel =
        repeat === 'one'
            ? t('player.repeatOne')
            : repeat === 'all'
              ? t('player.repeatAll')
              : t('player.repeatOff');
    const mainLabel = playbackError
        ? t('player.retry')
        : playing
          ? t('common.pause')
          : t('common.play');

    return (
        <div className={styles.root}>
            {showTransport && (
                <div className={styles.transport}>
                    <button
                        type="button"
                        className={styles.transportButton}
                        aria-label={t('common.prev')}
                        title={t('common.prev')}
                        onClick={prev}
                    >
                        <IconPrev size={18}/>
                    </button>
                    <button
                        type="button"
                        className={styles.transportMain}
                        aria-label={mainLabel}
                        title={mainLabel}
                        onClick={playbackError ? retryPlayback : toggle}
                    >
                        {playing ? <IconPause size={18}/> : <IconPlay size={18}/>}
                    </button>
                    <button
                        type="button"
                        className={styles.transportButton}
                        aria-label={t('common.next')}
                        title={t('common.next')}
                        onClick={next}
                    >
                        <IconNext size={18}/>
                    </button>
                </div>
            )}

            <div className={styles.modes}>
                <button
                    type="button"
                    className={styles.mode}
                    data-active={shuffle || undefined}
                    aria-pressed={shuffle}
                    title={shuffle ? t('player.shuffleOn') : t('player.shuffleOff')}
                    onClick={() => setShuffle(!shuffle)}
                >
                    <IconShuffle size={16}/>
                    <span>{shuffle ? t('player.shuffleOn') : t('player.shuffleOff')}</span>
                </button>

                <button
                    type="button"
                    className={styles.mode}
                    data-active={repeat !== 'off' || undefined}
                    aria-pressed={repeat !== 'off'}
                    title={repeatLabel}
                    /* 顺序与桌面播放条一致：off → all → one → off */
                    onClick={() =>
                        setRepeat(repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off')
                    }
                >
                    {repeat === 'one' ? <IconRepeatOne size={16}/> : <IconRepeat size={16}/>}
                    <span>{repeatLabel}</span>
                </button>

                <SleepTimerButton withLabel/>
            </div>
        </div>
    );
}

export default PlaybackModes;
