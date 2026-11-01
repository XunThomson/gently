import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {Button} from '../../components/ui/button';
import {EmptyState} from '../../components/ui/empty-state';
import {IconChevronDown, IconChevronLeft, IconMusic, IconPause, IconPlay} from '../../components/ui/icon';
import {Lyrics} from '../../components/ui/lyrics';
import {useActions, useSelect} from '../../store';
import {useShellMode} from '../../hooks/useShellMode';
import {Cover} from '../../components/ui/cover';
import {LyricsToolsDrawer} from './components/LyricsToolsDrawer';
import {readCoverMode, saveCoverMode, subscribeCoverMode, type CoverMode} from '../../utils/nowPlayingCover';
import styles from './now-playing.module.css';

/**
 * 歌词单独订阅 `elapsed / lyricsOffset`。
 *
 * 播放进度每 250ms 回写一次；如果 `NowPlayingView` 自己订阅 elapsed，整页
 * （封面、标题、工具抽屉、歌词列表）都会跟着重渲染。这里把进度下沉到歌词子树，
 * 页面壳只在曲目/播放态变化时更新。
 */
function NowPlayingLyrics() {
    const lines = useSelect((s) => s.player.lyrics);
    const elapsed = useSelect((s) => s.player.elapsed);
    const offset = useSelect((s) => s.player.lyricsOffset);
    const seek = useActions().player.seek;
    const onSeek = useCallback(
        (time: number) => seek(Math.max(0, time - offset)),
        [seek, offset],
    );

    return <Lyrics lines={lines} elapsed={elapsed + offset} onSeek={onSeek}/>;
}

/**
 * 歌词页。
 *
 * 默认只有「封面 + 歌词」：歌曲信息（歌手 / 专辑 / 时长 / 来源）在播放条，
 * 功能性操作（收藏 / 下载 / 加入歌单）在播放条的功能抽屉（AGENTS #9）。
 *
 * 与歌词直接相关的三件事收进右上角的**工具抽屉**（`components/LyricsToolsDrawer`）：
 * 时间轴校正、歌词来源、跨源搜索歌词。抽屉是**惰性**的——第一次点开才挂载，
 * 收起后不卸载（刚搜到的东西不该因为收起就没了）。
 */
export default function NowPlayingView() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const current = useSelect((s) => s.player.current);
    const detail = useSelect((s) => s.player.detail);
    const playing = useSelect((s) => s.player.playing);
    const {toggle} = useActions().player;
    /* 只有「被强制展开成完整界面」的迷你尺寸才需要单列；断点与外壳同一份配置 */
    const mode = useShellMode();
    const isMobile = mode === 'mobile';

    /* 手机端封面策略：默认不显示（歌词才是主角），可切成「作为背景」。
       偏好是这个页面自己的事，存 localStorage（与桌面歌词窗口设置同一种做法）。 */
    const [coverMode, setCoverMode] = useState<CoverMode>(readCoverMode);
    useEffect(() => subscribeCoverMode(setCoverMode), []);
    const toggleCover = () => {
        const next: CoverMode = coverMode === 'background' ? 'hidden' : 'background';
        saveCoverMode(next);
        setCoverMode(next);
    };

    /* 抽屉：`mounted` 一旦为 true 就不再回退（惰性挂载 + 保留内部状态） */
    const [toolsOpen, setToolsOpen] = useState(false);
    const [toolsMounted, setToolsMounted] = useState(false);

    const toggleTools = () => {
        setToolsOpen((open) => {
            if (!open) setToolsMounted(true);
            return !open;
        });
    };

    if (!current) {
        return (
            <div className={styles.page}>
                <EmptyState
                    icon={<IconMusic size={32}/>}
                    title={t('player.notPlaying')}
                    hint={t('player.pickSong')}
                />
            </div>
        );
    }

    /* 返回：有应用内历史就退一步；直接打开本页（刷新 / 深链）时退回首页，
       不把用户丢出应用（`navigate(-1)` 在栈底等于关闭窗口）。 */
    const goBack = () => {
        const idx =
            typeof window !== 'undefined'
                ? Number((window.history.state as {idx?: unknown} | null)?.idx ?? 0)
                : 0;
        if (idx > 0) navigate(-1);
        else navigate('/', {replace: true});
    };

    /* 封面优先用源侧详情（`catalog.track`）：列表快照常常只有标题歌手 */
    const artwork = detail ?? current;

    return (
        <div className={styles.page} data-cover={isMobile ? coverMode : 'inline'}>
            {isMobile && coverMode === 'background' && (
                <div className={styles.coverBackdrop} aria-hidden="true">
                    <Cover
                        className={styles.coverBackdropImage}
                        artwork={artwork.artwork}
                        gradient={artwork.gradient}
                        title={artwork.title}
                        artist={artwork.artist}
                    />
                </div>
            )}

            <div className={styles.topbar}>
                <button type="button" className={styles.back} onClick={goBack}>
                    <IconChevronLeft size={16}/>
                    {t('common.back')}
                </button>
                {isMobile && (
                    <button
                        type="button"
                        className={styles.coverToggle}
                        aria-pressed={coverMode === 'background'}
                        onClick={toggleCover}
                    >
                        {coverMode === 'background'
                            ? t('page.nowPlaying.coverBackground')
                            : t('page.nowPlaying.coverHidden')}
                    </button>
                )}
            </div>

            <div
                className={styles.layout}
                /* 单列：迷你尺寸（被强制展开）与手机都放不下「封面 + 歌词」两栏 */
                data-stack={mode === 'mini' || mode === 'mobile' ? 'true' : 'false'}
            >
                {/* 手机端永远不把封面放进正文：默认省略（高度还给歌词），开启后只作背景 */}
                {!isMobile && (
                <section className={styles.artwork}>
                    <Cover
                        className={styles.cover}
                        artwork={artwork.artwork}
                        gradient={artwork.gradient}
                        title={artwork.title}
                        artist={artwork.artist}
                    >
                        <span className={styles.initial}>{artwork.title.slice(0, 1)}</span>
                        <button
                            type="button"
                            className={styles.coverPlay}
                            aria-label={playing ? t('common.pause') : t('common.play')}
                            onClick={toggle}
                        >
                            {playing ? <IconPause size={16}/> : <IconPlay size={16}/>}
                        </button>
                    </Cover>
                    <p className={styles.caption}>{current.title}</p>
                </section>
                )}

                <section className={styles.lyricsPanel}>
                    <div className={styles.lyricsHeader}>
                        <h2 className={styles.lyricsTitle}>{t('page.nowPlaying.lyrics')}</h2>
                        <Button
                            size="sm"
                            variant="ghost"
                            aria-expanded={toolsOpen}
                            onClick={toggleTools}
                            icon={
                                <span className={styles.toolsChevron} data-open={toolsOpen}>
                                    <IconChevronDown size={14}/>
                                </span>
                            }
                        >
                            {t('page.nowPlaying.toolsToggle')}
                        </Button>
                    </div>

                    {toolsMounted && <LyricsToolsDrawer open={toolsOpen}/>}

                    <div className={styles.lyricsBody}>
                        <NowPlayingLyrics/>
                    </div>
                </section>
            </div>
        </div>
    );
}
