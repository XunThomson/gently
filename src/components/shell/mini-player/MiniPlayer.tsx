import {useTranslation} from 'react-i18next';
import {useActions, usePlayerState} from '../../../store';
import {isTauri, windowService} from '../../../services';
import {useTheme} from '../../../theme';
import {fmt} from '../../../utils/helpers';
import {playbackFailureText} from '../../../utils/playbackFailure';
import {Cover} from '../../ui/cover';
import {
    IconClose,
    IconMaximize,
    IconMinimize,
    IconMusic,
    IconNext,
    IconPause,
    IconPlay,
    IconPrev,
} from '../../ui/icon';
import {MiniLyrics} from '../../ui/lyrics';
import {SeekBar} from '../player-bar';
import styles from './MiniPlayer.module.css';

export interface MiniPlayerProps {
    /** 回到完整界面：桌面端恢复普通窗口尺寸，浏览器预览里由外壳切回完整布局 */
    onExpand: () => void;
}

/**
 * 迷你播放器：窗口小于断点后**替换整个外壳**，而不是把完整界面硬挤进小窗。
 *
 * 只保留「正在听什么」和「能操作什么」：
 * - 封面 / 标题 / 歌手 / 专辑；
 * - 上一首 / 播放暂停 / 下一首；
 * - 进度条与时间（复用播放条的 SeekBar，皮肤跟随主题）；
 * - 歌词（复用 `Lyrics` 的紧凑模式，当前行居中、可点击跳转）。
 *
 * 窗口拖动由根节点的 `data-tauri-drag-region="deep"` 提供；
 * 右上角保留「展开 / 最小化 / 关闭」，展开走 `windowService.restoreFromMini`
 * 把窗口恢复到普通尺寸，而不是让用户自己再拖回来。
 */
export function MiniPlayer({onExpand}: MiniPlayerProps) {
    const {t} = useTranslation();
    const {config} = useTheme();
    const {current, detail, playing, elapsed, duration, lyrics, lyricsOffset, playbackError} =
        usePlayerState();
    const {toggle, next, prev, seek, retryPlayback} = useActions().player;

    /* 封面优先用源侧详情（列表快照常常只有标题歌手） */
    const artwork = detail ?? current;
    const progressSkin = config.components.playerBar.progressThumbSkin;
    const failureText = playbackError ? playbackFailureText(playbackError, t) : '';
    const mainLabel = playbackError
        ? t('player.retry')
        : playing
            ? t('common.pause')
            : t('common.play');

    return (
        <div className={styles.page}>
            {/*
             * 拖动区只放在顶栏，不铺满整页：SeekBar 是 div，不在 Tauri 的
             * 「可点击元素阻断拖动」名单里，铺满整页会让进度条拖拽变成拖窗口。
             */}
            <header className={styles.header} data-tauri-drag-region="deep">
                <span className={styles.brand}>{t('app.title')}</span>
                <div className={styles.actions}>
                    <button
                        type="button"
                        className={styles.action}
                        title={t('miniPlayer.expand')}
                        aria-label={t('miniPlayer.expand')}
                        onClick={onExpand}
                    >
                        <IconMaximize size={14}/>
                    </button>
                    {isTauri() && (
                        <>
                            <button
                                type="button"
                                className={styles.action}
                                title={t('toolbar.minimize')}
                                aria-label={t('toolbar.minimize')}
                                onClick={() => void windowService.minimize()}
                            >
                                <IconMinimize size={14}/>
                            </button>
                            <button
                                type="button"
                                className={styles.action}
                                title={t('toolbar.close')}
                                aria-label={t('toolbar.close')}
                                onClick={() => void windowService.close()}
                            >
                                <IconClose size={14}/>
                            </button>
                        </>
                    )}
                </div>
            </header>

            {current ? (
                <>
                    <section className={styles.now}>
                        <Cover
                            className={styles.cover}
                            artwork={artwork?.artwork}
                            gradient={artwork?.gradient}
                            title={current.title}
                            artist={current.artist}
                        />

                        <div className={styles.meta}>
                            <span className={styles.title} title={current.title}>
                                {current.title}
                            </span>
                            {/* 播放失败时不能只是「看起来停着」：给一句话和重试入口（R71 的坑） */}
                            {playbackError ? (
                                <button
                                    type="button"
                                    className={styles.failure}
                                    title={failureText}
                                    onClick={retryPlayback}
                                >
                                    {failureText}
                                </button>
                            ) : (
                                <span className={styles.artist} title={current.artist}>
                                    {current.album
                                        ? `${current.artist} · ${current.album}`
                                        : current.artist}
                                </span>
                            )}
                        </div>

                        <div className={styles.transport}>
                            <button
                                type="button"
                                className={styles.ctrl}
                                title={t('common.prev')}
                                aria-label={t('common.prev')}
                                onClick={prev}
                            >
                                <IconPrev size={16}/>
                            </button>
                            <button
                                type="button"
                                className={styles.ctrlMain}
                                title={mainLabel}
                                aria-label={mainLabel}
                                onClick={playbackError ? retryPlayback : toggle}
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
                                <IconNext size={16}/>
                            </button>
                        </div>
                    </section>

                    <div className={styles.lyrics}>
                        <MiniLyrics
                            lines={lyrics}
                            elapsed={elapsed + lyricsOffset}
                            onSeek={(time) => seek(Math.max(0, time - lyricsOffset))}
                        />
                    </div>

                    <footer className={styles.footer}>
                        <div className={styles.seek}>
                            <SeekBar
                                elapsed={elapsed}
                                duration={duration}
                                skin={progressSkin}
                                onSeek={seek}
                            />
                        </div>
                        <span className={styles.time}>
                            {fmt(elapsed)} / {duration > 0 ? fmt(duration) : '0:00'}
                        </span>
                    </footer>
                </>
            ) : (
                <div className={styles.empty}>
                    <IconMusic size={28}/>
                    <p className={styles.emptyTitle}>{t('miniPlayer.noTrack')}</p>
                    <p className={styles.emptyHint}>{t('miniPlayer.pickSong')}</p>
                </div>
            )}
        </div>
    );
}

export default MiniPlayer;
