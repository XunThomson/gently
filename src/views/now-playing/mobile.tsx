import {useRef, useState, type PointerEvent as ReactPointerEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {
    IconChevronDown,
    IconHeart,
    IconMore,
    IconPause,
    IconPlay,
    IconPrev,
    IconNext,
    IconRepeat,
    IconRepeatOne,
    IconShuffle,
    IconVolume,
} from '../../components/ui/icon';
import {SeekBar} from '../../components/shell/player-bar';
import {useTheme} from '../../theme';
import {useActions, useSelect} from '../../store';
import {fmt} from '../../utils/helpers';
import {qualityLabelKey} from '../../utils/quality';
import {nowPlayingDragOpacity, shouldDismissNowPlaying} from '../../utils/nowPlayingGesture';
import {NowPlayingLyrics} from './components/NowPlayingLyrics';
import {MobileToolsSheet, type MobileToolsTab} from './components/MobileToolsSheet';
import {useNowPlayingBack} from './useNowPlayingBack';
import {requestMobileDrawer} from '../../components/shell/mobile/drawerBus';
import styles from './mobile.module.css';

/**
 * 手机歌词页 / 全屏播放页（R144）。
 *
 * 参考主流播放器（网易云等）的层级：**歌词占主视觉、居中**；底部依次是
 * 操作图标行 → 进度 → 上一首 / 播放暂停 / 下一首。全局播放条在这个页面隐藏
 * （`MobileShell` 的 immersive），避免两套传输控件；导航仍在左侧抽屉
 * （顶栏隐藏，横滑可拉出；系统返回也能回），不另放底部导航。
 *
 * 功能不塞进窄条：底部只放**收藏 / 播放模式 / 音质 / 更多**四个 44px 图标；
 * 「更多」打开播放 / 歌词 / 队列面板，下载 / 歌单等在面板里。
 * 底部控制区上划可打开侧边抽屉；顶栏下滑关闭歌词页。
 * 底部工具面板由「更多 / 音质」按钮打开。
 *
 * 与桌面端的隔离：桌面走 `desktop.tsx`（右上角竖排图标栏），这里只服务手机。
 */
export function MobileNowPlaying() {
    const {t} = useTranslation();
    const goBack = useNowPlayingBack();
    const {config} = useTheme();
    const current = useSelect((s) => s.player.current);
    const playing = useSelect((s) => s.player.playing);
    const elapsed = useSelect((s) => s.player.elapsed);
    const duration = useSelect((s) => s.player.duration);
    const playbackError = useSelect((s) => s.player.playbackError);
    const repeat = useSelect((s) => s.player.repeat);
    const shuffle = useSelect((s) => s.player.shuffle);
    const preferredQuality = useSelect((s) => s.ui.preferredQuality);
    const {toggle, next, prev, seek, retryPlayback, setRepeat, setShuffle} = useActions().player;
    const {toggleFavorite} = useActions().collection;
    const isFavorite = useSelect(
        (s) =>
            !!s.player.current &&
            s.collection.favorites.some((track) => track.id === s.player.current?.id),
    );

    const [sheet, setSheet] = useState<MobileToolsTab | null>(null);

    /* 下滑关闭（R144）：从顶栏往下拖，超过阈值就收起歌词页；没到阈值弹回。
       为什么只在顶栏：歌词区必须能正常滚动，在整页上抢垂直手势会把滚动吃掉；
       顶栏没有滚动语义，`touch-action: none` 是安全的。 */
    const [dragY, setDragY] = useState(0);
    const [dragHeight, setDragHeight] = useState(0);
    const [dragging, setDragging] = useState(false);
    const dragRef = useRef<{id: number; startY: number; active: boolean} | null>(null);

    const onDragStart = (event: ReactPointerEvent<HTMLElement>) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('button')) return;
        dragRef.current = {id: event.pointerId, startY: event.clientY, active: false};
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragHeight(window.innerHeight);
    };

    const onDragMove = (event: ReactPointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dy = event.clientY - drag.startY;
        if (!drag.active && dy > 4) {
            drag.active = true;
            setDragging(true);
        }
        if (drag.active) setDragY(Math.max(0, dy));
    };

    const onDragEnd = (event: ReactPointerEvent<HTMLElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        const signed = event.clientY - drag.startY;
        /* 顶栏上划 = 打开侧边抽屉（R145，目标里的「歌词页上划打开抽屉」） */
        if (!drag.active && signed < -60) {
            requestMobileDrawer();
            setDragY(0);
            return;
        }
        const dy = Math.max(0, signed);
        if (drag.active && shouldDismissNowPlaying(dy, dragHeight)) {
            goBack();
            return;
        }
        setDragY(0);
    };

    /* 底部控制区上划打开侧边抽屉（R145）：从空白处往上拉，按钮仍可正常点。
       （底部工具面板本身由「更多 / 音质」按钮打开，不跟上划抢同一个手势。） */
    const footerSwipe = useRef<{id: number; startY: number} | null>(null);
    const onFooterDown = (event: ReactPointerEvent<HTMLElement>) => {
        if (!event.isPrimary) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest('button, input, [role="slider"]')) return;
        footerSwipe.current = {id: event.pointerId, startY: event.clientY};
        event.currentTarget.setPointerCapture(event.pointerId);
    };
    const onFooterUp = (event: ReactPointerEvent<HTMLElement>) => {
        const start = footerSwipe.current;
        if (!start || start.id !== event.pointerId) return;
        footerSwipe.current = null;
        if (event.clientY - start.startY < -64) requestMobileDrawer();
    };

    if (!current) return null;

    const skin = config.components.playerBar.progressThumbSkin;
    const mainLabel = playbackError
        ? t('player.retry')
        : playing
          ? t('common.pause')
          : t('common.play');

    const mode = shuffle ? 'shuffle' : repeat === 'one' ? 'one' : repeat === 'all' ? 'all' : 'off';
    const modeLabel =
        mode === 'shuffle'
            ? t('player.shuffleOn')
            : mode === 'one'
              ? t('player.repeatOne')
              : mode === 'all'
                ? t('player.repeatAll')
                : t('player.repeatOff');
    const cycleMode = () => {
        if (shuffle) {
            setShuffle(false);
            setRepeat('off');
            return;
        }
        if (repeat === 'off') {
            setRepeat('all');
            return;
        }
        if (repeat === 'all') {
            setRepeat('one');
            return;
        }
        setRepeat('off');
        setShuffle(true);
    };
    const qualityText = t(qualityLabelKey(preferredQuality));

    return (
        <div
            className={styles.page}
            data-sheet={sheet !== null}
            data-dragging={dragging}
            style={
                dragY > 0
                    ? {
                          transform: `translateY(${dragY}px)`,
                          opacity: nowPlayingDragOpacity(dragY, dragHeight),
                      }
                    : undefined
            }
        >
            <header
                className={styles.topbar}
                onPointerDown={onDragStart}
                onPointerMove={onDragMove}
                onPointerUp={onDragEnd}
                onPointerCancel={onDragEnd}
            >
                <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={t('page.nowPlaying.collapse')}
                    title={t('page.nowPlaying.collapse')}
                    onClick={goBack}
                >
                    <IconChevronDown size={20}/>
                </button>

                <div className={styles.heading}>
                    <h1 className={styles.title}>{current.title}</h1>
                    <p className={styles.artist}>{current.artist}</p>
                </div>

                <span className={styles.topbarSpacer} aria-hidden="true"/>
            </header>

            <main className={styles.stage}>
                <div className={styles.lyrics}>
                    <NowPlayingLyrics centered/>
                </div>
            </main>

            <footer className={styles.controls}>
                <div
                    className={styles.actions}
                    onPointerDown={onFooterDown}
                    onPointerUp={onFooterUp}
                    onPointerCancel={onFooterUp}
                >
                    <button
                        type="button"
                        className={styles.action}
                        data-active={isFavorite}
                        aria-pressed={isFavorite}
                        aria-label={isFavorite ? t('common.unfavorite') : t('common.favorite')}
                        title={isFavorite ? t('common.unfavorite') : t('common.favorite')}
                        onClick={() => toggleFavorite(current)}
                    >
                        <IconHeart size={20} fill={isFavorite ? 'currentColor' : 'none'}/>
                    </button>

                    <button
                        type="button"
                        className={styles.action}
                        data-active={mode !== 'off'}
                        aria-label={modeLabel}
                        title={modeLabel}
                        onClick={cycleMode}
                    >
                        {mode === 'shuffle' ? (
                            <IconShuffle size={20}/>
                        ) : mode === 'one' ? (
                            <IconRepeatOne size={20}/>
                        ) : (
                            <IconRepeat size={20}/>
                        )}
                    </button>

                    <button
                        type="button"
                        className={styles.action}
                        aria-label={`${t('quality.label')}：${qualityText}`}
                        title={`${t('quality.label')}：${qualityText}`}
                        onClick={() => setSheet('quality')}
                    >
                        <IconVolume size={20}/>
                    </button>

                    <button
                        type="button"
                        className={styles.action}
                        aria-label={t('player.actions')}
                        title={t('player.actions')}
                        onClick={() => setSheet('playback')}
                    >
                        <IconMore size={20}/>
                    </button>
                </div>

                <div className={styles.seekRow}>
                    <span className={styles.time}>{fmt(elapsed)}</span>
                    <div className={styles.seekHit}>
                        <SeekBar
                            elapsed={elapsed}
                            duration={duration}
                            skin={skin}
                            onSeek={seek}
                        />
                    </div>
                    <span className={styles.time}>{duration > 0 ? fmt(duration) : '0:00'}</span>
                </div>

                <div className={styles.transport}>
                    <button
                        type="button"
                        className={styles.transportButton}
                        aria-label={t('common.prev')}
                        title={t('common.prev')}
                        onClick={prev}
                    >
                        <IconPrev size={22}/>
                    </button>

                    <button
                        type="button"
                        className={styles.transportMain}
                        aria-label={mainLabel}
                        title={mainLabel}
                        onClick={playbackError ? retryPlayback : toggle}
                    >
                        {playing ? <IconPause size={24}/> : <IconPlay size={24}/>}
                    </button>

                    <button
                        type="button"
                        className={styles.transportButton}
                        aria-label={t('common.next')}
                        title={t('common.next')}
                        onClick={next}
                    >
                        <IconNext size={22}/>
                    </button>
                </div>
            </footer>

            {sheet !== null && (
                <MobileToolsSheet initialTab={sheet} onClose={() => setSheet(null)}/>
            )}
        </div>
    );
}

export default MobileNowPlaying;
