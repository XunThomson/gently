import {useCallback, type MouseEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {useActions, useSelect} from '../../../store';
import type {RepeatMode} from '../../../types';
import {fmt} from '../../../utils/helpers';
import {IconNext, IconPause, IconPlay, IconPrev, IconRepeat, IconRepeatOne, IconVolume} from '../../ui/icon';
import styles from './PlayerBar.module.css';

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = {off: 'all', all: 'one', one: 'off'};

/**
 * 底部播放条：纯展示 + 派发命令，播放状态全部来自集中式 store。
 */
export function PlayerBar() {
    const {t} = useTranslation();
    const player = useSelect((s) => s.player);
    const {toggle, next, prev, setRepeat, setVolume, seek} = useActions().player;

    const {current, playing, elapsed, duration, repeat, volume} = player;
    const percent = duration > 0 ? (elapsed / duration) * 100 : 0;

    const repeatLabel =
        repeat === 'one' ? t('player.repeatOne') : repeat === 'all' ? t('player.repeatAll') : t('player.repeatOff');

    const handleSeek = useCallback(
        (e: MouseEvent<HTMLDivElement>) => {
            if (duration <= 0) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = (e.clientX - rect.left) / rect.width;
            seek(Math.round(ratio * duration));
        },
        [duration, seek],
    );

    return (
        <div className={styles.player}>
            <div className={styles.left}>
                <div
                    className={styles.cover}
                    style={current ? {background: current.gradient} : undefined}
                >
                    {current ? current.title.slice(0, 1) : '♪'}
                </div>
                <div className={styles.info}>
                    <div className={styles.title}>{current ? current.title : t('player.notPlaying')}</div>
                    <div className={styles.artist}>
                        {current ? `${current.artist} · ${current.album}` : t('player.pickSong')}
                    </div>
                </div>
            </div>

            <div className={styles.center}>
                <div className={styles.controls}>
                    <button
                        type="button"
                        className={styles.ctrl}
                        title={t('common.prev')}
                        aria-label={t('common.prev')}
                        onClick={prev}
                    >
                        <IconPrev size={17}/>
                    </button>

                    <button
                        type="button"
                        className={styles.ctrlMain}
                        title={playing ? t('common.pause') : t('common.play')}
                        aria-label={playing ? t('common.pause') : t('common.play')}
                        onClick={toggle}
                    >
                        {playing ? <IconPause size={14}/> : <IconPlay size={14}/>}
                    </button>

                    <button
                        type="button"
                        className={styles.ctrl}
                        title={t('common.next')}
                        aria-label={t('common.next')}
                        onClick={next}
                    >
                        <IconNext size={17}/>
                    </button>
                </div>

                <div className={styles.progress}>
                    <span className={styles.time}>{fmt(elapsed)}</span>
                    <div
                        className={styles.bar}
                        role="slider"
                        aria-label={t('column.progress')}
                        aria-valuemin={0}
                        aria-valuemax={duration}
                        aria-valuenow={elapsed}
                        tabIndex={0}
                        onClick={handleSeek}
                    >
                        <i style={{width: `${percent}%`}}/>
                    </div>
                    <span className={styles.time}>{duration > 0 ? fmt(duration) : '0:00'}</span>
                </div>
            </div>

            <div className={styles.right}>
                <button
                    type="button"
                    className={styles.iconBtn}
                    title={repeatLabel}
                    aria-label={repeatLabel}
                    aria-pressed={repeat !== 'off'}
                    onClick={() => setRepeat(NEXT_REPEAT[repeat])}
                >
                    {repeat === 'one' ? <IconRepeatOne size={15}/> : <IconRepeat size={15}/>}
                </button>

                <div className={styles.volume}>
                    <IconVolume size={15}/>
                    <input
                        type="range"
                        className={styles.volumeRange}
                        min={0}
                        max={100}
                        value={Math.round(volume * 100)}
                        aria-label={t('player.volume')}
                        onChange={(e) => setVolume(Number(e.target.value) / 100)}
                    />
                </div>
            </div>
        </div>
    );
}

export default PlayerBar;
