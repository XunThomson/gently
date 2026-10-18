import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {Button} from '../../components/ui/button';
import {EmptyState} from '../../components/ui/empty-state';
import {IconChevronDown, IconChevronLeft, IconMusic, IconPause, IconPlay} from '../../components/ui/icon';
import {Lyrics} from '../../components/ui/lyrics';
import {useActions, usePlayerState} from '../../store';
import {trackCoverStyle} from '../../utils/cover';
import {LyricsToolsDrawer} from './components/LyricsToolsDrawer';
import styles from './now-playing.module.css';

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
    const {current, detail, playing, elapsed, lyrics, lyricsOffset} = usePlayerState();
    const {seek, toggle} = useActions().player;

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
        <div className={styles.page}>
            <button type="button" className={styles.back} onClick={goBack}>
                <IconChevronLeft size={16}/>
                {t('common.back')}
            </button>

            <div className={styles.layout}>
                <section className={styles.artwork}>
                    <div
                        className={styles.cover}
                        style={trackCoverStyle(artwork)}
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
                    </div>
                    <p className={styles.caption}>{current.title}</p>
                </section>

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
                        <Lyrics
                            lines={lyrics}
                            elapsed={elapsed + lyricsOffset}
                            onSeek={(time) => seek(Math.max(0, time - lyricsOffset))}
                        />
                    </div>
                </section>
            </div>
        </div>
    );
}
