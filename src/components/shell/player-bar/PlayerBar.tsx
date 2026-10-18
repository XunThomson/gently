import {useEffect, useRef, useState, type KeyboardEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate, useLocation} from 'react-router';
import {useClickOutside} from '../../../hooks/useClickOutside';
import {appConfig} from '../../../config/app.config';
import {useActions, usePlayerState, useSelect} from '../../../store';
import {useTheme} from '../../../theme';
import type {RepeatMode} from '../../../types';
import {trackCoverStyle} from '../../../utils/cover';
import {fmt} from '../../../utils/helpers';
import {
    IconHeart,
    IconList,
    IconMore,
    IconNext,
    IconPause,
    IconPlay,
    IconPrev,
    IconRepeat,
    IconRepeatOne,
    IconVolume,
} from '../../ui/icon';
import {ActionsPanel} from './ActionsPanel';
import {QualityPicker} from './QualityPicker';
import {QueuePanel} from './QueuePanel';
import {SeekBar} from './SeekBar';
import {SourcePicker} from './SourcePicker';
import styles from './PlayerBar.module.css';

const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = {off: 'all', all: 'one', one: 'off'};

type PanelKind = 'queue' | 'actions';

/** 歌词页路径（路由表里同一个字面量） */
const NOW_PLAYING_PATH = '/now-playing';

/**
 * 点击播放条封面 / 标题是否应该**新压入**一条歌词页历史。
 *
 * 已经在歌词页时为 `false`：播放条在歌词页里仍然可见，每点一次都 `navigate()`
 * 就会往历史栈里塞一条重复的 `/now-playing`，用户得点同样多次「返回」才回得去
 * （这是一个真实报上来的 bug）。纯函数，冒烟能直接钉住它。
 */
export function shouldOpenNowPlaying(pathname: string): boolean {
    return pathname !== NOW_PLAYING_PATH;
}

/**
 * 底部播放条。
 *
 * - 进度条贴在播放条顶边（bilibili 式，默认无焦点，悬浮才显示）；
 * - 歌曲信息（标题 / 歌手 / 专辑 / 时长 / 来源）随播放在此展示；
 * - 功能性操作收敛到「功能抽屉」，播放队列收敛到「播放列表抽屉」。
 */
export function PlayerBar() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const player = usePlayerState();
    const {toggle, next, prev, setRepeat, setVolume, seek} = useActions().player;
    const {toggleFavorite} = useActions().collection;
    const isFavorite = useSelect(
        (s) =>
            !!s.player.current &&
            s.collection.favorites.some((track) => track.id === s.player.current?.id),
    );

    const [panel, setPanel] = useState<PanelKind | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    useClickOutside(rootRef, () => setPanel(null), panel !== null);

    useEffect(() => {
        if (!panel) return;
        const onKeyDown = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') setPanel(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [panel]);

    const {config} = useTheme();
    const {current, detail, playing, elapsed, duration, repeat, volume} = player;
    /* 封面优先用**源侧详情**（`catalog.track` 补的元数据）：列表快照常常没有封面 */
    const artwork = detail ?? current;
    const progressSkin = config.components.playerBar.progressThumbSkin;

    const repeatLabel =
        repeat === 'one'
            ? t('player.repeatOne')
            : repeat === 'all'
                ? t('player.repeatAll')
                : t('player.repeatOff');

    const openDetail = () => {
        if (!current) return;
        /* 已经在歌词页就不要再 push 一条历史（见 `shouldOpenNowPlaying`） */
        if (!shouldOpenNowPlaying(location.pathname)) return;
        navigate(NOW_PLAYING_PATH);
    };

    const togglePanel = (kind: PanelKind) => setPanel((prev) => (prev === kind ? null : kind));

    const handleVolumeKey = (e: KeyboardEvent<HTMLInputElement>) => {
        const step = appConfig.player.volumeStep;
        if (e.key === 'ArrowUp') setVolume(volume + step);
        else if (e.key === 'ArrowDown') setVolume(volume - step);
    };

    return (
        <div className={styles.player} ref={rootRef}>
            {/* 顶边进度条 */}
            <SeekBar elapsed={elapsed} duration={duration} skin={progressSkin} onSeek={seek}/>

            {panel === 'queue' && <QueuePanel onClose={() => setPanel(null)}/>}
            {panel === 'actions' && <ActionsPanel onClose={() => setPanel(null)}/>}

            <div className={styles.row}>
                {/* ---------- 左：歌曲信息 ---------- */}
                <div className={styles.left}>
                    <button
                        type="button"
                        className={styles.cover}
                        style={
                            artwork
                                ? trackCoverStyle(artwork)
                                : undefined
                        }
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

                        <div className={styles.meta}>
                            <span className={styles.artist}>
                                {current ? `${current.artist} · ${current.album}` : t('player.pickSong')}
                            </span>
                            {current && (
                                <span className={styles.chips}>
                                    <span className={styles.chip}>{current.duration}</span>
                                </span>
                            )}
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

                {/* ---------- 中：传输控制 ---------- */}
                <div className={styles.center}>
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

                    <span className={styles.time}>
                        {fmt(elapsed)} / {duration > 0 ? fmt(duration) : '0:00'}
                    </span>
                </div>

                {/* ---------- 右：音源 / 音质 / 模式 / 抽屉 / 音量 ---------- */}
                <div className={styles.right}>
                    <SourcePicker/>
                    <QualityPicker/>

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

                    <button
                        type="button"
                        className={styles.iconBtn}
                        title={t('player.queue')}
                        aria-label={t('player.queue')}
                        aria-pressed={panel === 'queue'}
                        onClick={() => togglePanel('queue')}
                    >
                        <IconList size={16}/>
                    </button>

                    <button
                        type="button"
                        className={styles.iconBtn}
                        title={t('player.actions')}
                        aria-label={t('player.actions')}
                        aria-pressed={panel === 'actions'}
                        onClick={() => togglePanel('actions')}
                    >
                        <IconMore size={16}/>
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
                            onKeyDown={handleVolumeKey}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

export default PlayerBar;
