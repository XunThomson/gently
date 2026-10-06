import {useCallback, useRef, useState, type KeyboardEvent, type PointerEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {useActions, usePlayerState, useSelect} from '../../../store';
import type {RepeatMode} from '../../../types';
import {fmt} from '../../../utils/helpers';
import {
    IconHeart,
    IconNext,
    IconPause,
    IconPlay,
    IconPrev,
    IconRepeat,
    IconRepeatOne,
    IconVolume,
} from '../../ui/icon';
import styles from './PlayerBar.module.css';

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = {off: 'all', all: 'one', one: 'off'};
const SEEK_STEP = 5;

/**
 * 底部播放条：纯展示 + 派发命令，播放状态全部来自集中式 store。
 *
 * 交互约定（与列表保持一致）：
 * - 列表里点当前曲目 = 播放/暂停切换；
 * - 播放条主按钮只负责播放/暂停，未在播放时禁用；
 * - 进度条支持点击与拖拽，并支持 ←/→ 微调；
 * - 封面 / 曲名点击进入歌曲详情（歌词页）。
 */
export function PlayerBar() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const player = usePlayerState();
    const {toggle, next, prev, setRepeat, setVolume, seek} = useActions().player;
    const {toggleFavorite} = useActions().collection;
    const isFavorite = useSelect(
        (s) =>
            !!s.player.current &&
            s.collection.favorites.some((track) => track.id === s.player.current?.id),
    );

    const {current, playing, elapsed, duration, repeat, volume} = player;

    const barRef = useRef<HTMLDivElement>(null);
    const [dragRatio, setDragRatio] = useState<number | null>(null);

    const ratioFromClientX = useCallback((clientX: number): number => {
        const rect = barRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return 0;
        return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    }, []);

    const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
        if (duration <= 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragRatio(ratioFromClientX(e.clientX));
    };

    const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
        if (dragRatio === null) return;
        setDragRatio(ratioFromClientX(e.clientX));
    };

    const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
        if (dragRatio === null) return;
        seek(Math.round(dragRatio * duration));
        setDragRatio(null);
        e.currentTarget.releasePointerCapture?.(e.pointerId);
    };

    const handleSeekKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (duration <= 0) return;
        if (e.key === 'ArrowLeft') {
            e.preventDefault();
            seek(elapsed - SEEK_STEP);
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            seek(elapsed + SEEK_STEP);
        }
    };

    const repeatLabel =
        repeat === 'one'
            ? t('player.repeatOne')
            : repeat === 'all'
                ? t('player.repeatAll')
                : t('player.repeatOff');

    const shownElapsed = dragRatio === null ? elapsed : Math.round(dragRatio * duration);
    const shownPercent = duration > 0 ? ((dragRatio ?? elapsed / duration) * 100) : 0;

    const openDetail = () => {
        if (current) navigate('/now-playing');
    };

    return (
        <div className={styles.player}>
            <div className={styles.left}>
                <button
                    type="button"
                    className={styles.cover}
                    style={current ? {background: current.gradient} : undefined}
                    title={current ? t('player.openDetail') : undefined}
                    aria-label={current ? t('player.openDetail') : undefined}
                    disabled={!current}
                    onClick={openDetail}
                >
                    {current ? current.title.slice(0, 1) : '♪'}
                </button>

                <div className={styles.info}>
                    <button
                        type="button"
                        className={styles.title}
                        disabled={!current}
                        onClick={openDetail}
                    >
                        {current ? current.title : t('player.notPlaying')}
                    </button>
                    <div className={styles.artist}>
                        {current ? `${current.artist} · ${current.album}` : t('player.pickSong')}
                    </div>
                </div>

                <button
                    type="button"
                    className={styles.favorite}
                    aria-label={isFavorite ? t('common.unfavorite') : t('common.favorite')}
                    aria-pressed={isFavorite}
                    title={isFavorite ? t('common.unfavorite') : t('common.favorite')}
                    disabled={!current}
                    onClick={() => current && toggleFavorite(current)}
                >
                    <IconHeart size={16} fill={isFavorite ? 'currentColor' : 'none'}/>
                </button>
            </div>

            <div className={styles.center}>
                <div className={styles.controls}>
                    <button
                        type="button"
                        className={styles.ctrl}
                        title={t('common.prev')}
                        aria-label={t('common.prev')}
                        disabled={!current}
                        onClick={prev}
                    >
                        <IconPrev size={17}/>
                    </button>

                    <button
                        type="button"
                        className={styles.ctrlMain}
                        title={playing ? t('common.pause') : t('common.play')}
                        aria-label={playing ? t('common.pause') : t('common.play')}
                        disabled={!current}
                        onClick={toggle}
                    >
                        {playing ? <IconPause size={14}/> : <IconPlay size={14}/>}
                    </button>

                    <button
                        type="button"
                        className={styles.ctrl}
                        title={t('common.next')}
                        aria-label={t('common.next')}
                        disabled={!current}
                        onClick={next}
                    >
                        <IconNext size={17}/>
                    </button>
                </div>

                <div className={styles.progress}>
                    <span className={styles.time}>{fmt(shownElapsed)}</span>
                    <div
                        ref={barRef}
                        className={`${styles.bar}${dragRatio !== null ? ` ${styles.dragging}` : ''}`}
                        role="slider"
                        tabIndex={0}
                        aria-label={t('column.progress')}
                        aria-valuemin={0}
                        aria-valuemax={duration}
                        aria-valuenow={shownElapsed}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onPointerCancel={handlePointerUp}
                        onKeyDown={handleSeekKey}
                    >
                        <i style={{width: `${shownPercent}%`}}/>
                        <span className={styles.thumb} style={{left: `${shownPercent}%`}}/>
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
