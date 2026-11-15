import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Cover} from '../../components/ui/cover';
import {IconChevronLeft, IconClose, IconLyrics, IconMoon, IconMore} from '../../components/ui/icon';
import {ActionsPanel} from '../../components/shell/player-bar';
import {useActions, useSelect} from '../../store';
import {useShellMode} from '../../hooks/useShellMode';
import {NowPlayingLyrics} from './components/NowPlayingLyrics';
import {LyricsTools} from './components/LyricsTools';
import {useNowPlayingBack} from './useNowPlayingBack';
import styles from './desktop.module.css';

const TIMER_PRESETS = [3, 5, 10, 15, 30, 45, 60] as const;

/**
 * 桌面歌词页（R145 收敛）。
 *
 * 目标：**歌词是唯一主角**。
 * - 歌词居中、占满剩余高度；顶栏保留 44px 缩略图，**不再用封面做整页背景**；
 * - 右上角竖排图标栏只保留播放条没有的两项：**歌词工具**与**定时关闭**。
 *   收藏 / 下载 / 歌单 / 队列 / 播放模式 / 音源音质都在播放条里，不在这里重复；
 * - 点图标在右侧展开面板；Esc / 点舞台 / 点关闭都能收。
 *
 * 与移动端的隔离：这一份是桌面专用布局与样式，移动端走 `mobile.tsx`，
 * 两边只共用「歌词区 / 工具内容」这些与布局无关的组件。
 */
export function DesktopNowPlaying() {
    const {t} = useTranslation();
    const goBack = useNowPlayingBack();
    const current = useSelect((s) => s.player.current);
    const detail = useSelect((s) => s.player.detail);
    const sleepTimerMode = useSelect((s) => s.ui.sleepTimerMode);
    const shellMode = useShellMode();
    const {setSleepTimer, setSleepTimerEndOfTrack, cancelSleepTimer} = useActions().ui;

    const [lyricsOpen, setLyricsOpen] = useState(false);
    const [moreOpen, setMoreOpen] = useState(false);
    const [timerOpen, setTimerOpen] = useState(false);

    const panelOpen = lyricsOpen || moreOpen;
    const closePanel = () => {
        setLyricsOpen(false);
        setMoreOpen(false);
    };

    /* 面板 / 定时浮层开着时按 Esc 收起：不抢输入框（歌词搜索）里的 Esc */
    useEffect(() => {
        if (!panelOpen && !timerOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            const target = event.target as HTMLElement | null;
            if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
            if (timerOpen) setTimerOpen(false);
            else closePanel();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [panelOpen, timerOpen]);

    if (!current) return null;

    /* 封面优先用源侧详情（列表快照常常只有标题歌手） */
    const artwork = detail ?? current;

    return (
        <div className={styles.page} data-panel={panelOpen}>
            <header className={styles.topbar}>
                <button type="button" className={styles.back} onClick={goBack}>
                    <IconChevronLeft size={16}/>
                    <span>{t('common.back')}</span>
                </button>

                <div className={styles.nowPlaying}>
                    <Cover
                        className={styles.coverThumb}
                        artwork={artwork.artwork}
                        gradient={artwork.gradient}
                        title={artwork.title}
                        artist={artwork.artist}
                    />
                    <div className={styles.nowPlayingMeta}>
                        <h1 className={styles.title}>{current.title}</h1>
                        <p className={styles.meta}>
                            {current.artist}
                            {current.album ? ` · ${current.album}` : ''}
                        </p>
                    </div>
                </div>

                <span className={styles.topbarSpacer} aria-hidden="true"/>
            </header>

            {/* 右上角竖排功能栏：只留播放条没有的歌词工具 / 定时关闭 */}
            <nav className={styles.rail} aria-label={t('page.nowPlaying.toolTabs')}>
                <button
                    type="button"
                    className={styles.railButton}
                    data-active={lyricsOpen}
                    aria-expanded={lyricsOpen}
                    title={t('page.nowPlaying.toolsToggle')}
                    aria-label={t('page.nowPlaying.toolsToggle')}
                    onClick={() => setLyricsOpen((prev) => !prev)}
                >
                    <IconLyrics size={18}/>
                </button>

                <button
                    type="button"
                    className={styles.railButton}
                    data-active={moreOpen}
                    aria-expanded={moreOpen}
                    title={t('player.actions')}
                    aria-label={t('player.actions')}
                    onClick={() => {
                        setMoreOpen((prev) => !prev);
                        setLyricsOpen(false);
                    }}
                >
                    <IconMore size={18}/>
                </button>

                <button
                    type="button"
                    className={styles.railButton}
                    data-active={sleepTimerMode !== null}
                    title={t('sleepTimer.title')}
                    aria-label={t('sleepTimer.title')}
                    onClick={() => {
                        setTimerOpen((prev) => !prev);
                        closePanel();
                    }}                >
                    <IconMoon size={18}/>
                </button>
            </nav>

            {panelOpen && (
                <aside
                    className={styles.sidePanel}
                    aria-label={moreOpen ? t('player.actions') : t('page.nowPlaying.toolsToggle')}
                >
                    <div className={styles.panelHead}>
                        <h2 className={styles.panelTitle}>
                            {moreOpen ? t('player.actions') : t('page.nowPlaying.toolsToggle')}
                        </h2>
                        <button
                            type="button"
                            className={styles.panelClose}
                            aria-label={t('toolbar.close')}
                            title={t('toolbar.close')}
                            onClick={closePanel}
                        >
                            <IconClose size={14}/>
                        </button>
                    </div>

                    <div className={styles.panelBody}>
                        {moreOpen ? (
                            <div className={styles.morePanel}>
                                <ActionsPanel
                                    inline
                                    showDetail={false}
                                    showSourceQuality={shellMode === 'compact'}
                                    onClose={closePanel}
                                />
                            </div>
                        ) : (
                            <LyricsTools active/>
                        )}
                    </div>
                </aside>
            )}

            {/* 歌词舞台：点空白处收面板 */}
            <main className={styles.stage} onClick={closePanel}>
                <div className={styles.lyricsColumn}>
                    <NowPlayingLyrics centered/>
                </div>
            </main>

            {timerOpen && (
                <div
                    className={styles.timerPopover}
                    role="dialog"
                    aria-label={t('sleepTimer.title')}
                >
                    <div className={styles.timerHead}>
                        <span className={styles.timerTitle}>{t('sleepTimer.title')}</span>
                        <button
                            type="button"
                            className={styles.timerClose}
                            aria-label={t('toolbar.close')}
                            title={t('toolbar.close')}
                            onClick={() => setTimerOpen(false)}
                        >
                            <IconClose size={13}/>
                        </button>
                    </div>
                    <div className={styles.timerGrid}>
                        {TIMER_PRESETS.map((minutes) => (
                            <button
                                key={minutes}
                                type="button"
                                className={styles.timerOption}
                                onClick={() => {
                                    setSleepTimer(minutes);
                                    setTimerOpen(false);
                                }}
                            >
                                {t('sleepTimer.minutes', {count: minutes})}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        className={styles.timerAction}
                        onClick={() => {
                            setSleepTimerEndOfTrack();
                            setTimerOpen(false);
                        }}
                    >
                        {t('sleepTimer.endOfTrack')}
                    </button>
                    {sleepTimerMode !== null && (
                        <button
                            type="button"
                            className={styles.timerCancel}
                            onClick={() => {
                                cancelSleepTimer();
                                setTimerOpen(false);
                            }}
                        >
                            {t('sleepTimer.cancel')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

export default DesktopNowPlaying;
