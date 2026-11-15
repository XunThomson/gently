import {useTranslation} from 'react-i18next';
import {useLocation, useNavigate} from 'react-router';
import {useActions, usePlayerState} from '../../../store';
import {useTheme} from '../../../theme';
import {Cover} from '../../ui/cover';
import {IconNext, IconPause, IconPlay, IconPrev} from '../../ui/icon';
import {SeekBar, shouldOpenNowPlaying} from '../player-bar';
import styles from './MobilePlayerBar.module.css';

/**
 * 移动端常驻播放条（R143 收敛）。
 *
 * 只保留**播放本身**需要的四个位：主体（封面 + 标题，点进歌词页）/ 上一首 /
 * 播放暂停 / 下一首。收藏、下载、歌单、音源音质、播放模式、定时关闭、队列
 * 全部在歌词页的 tool tabs 里（AGENTS #9）——窄条里再塞「更多」只会又小又难点，
 * 而且那个浮层在 WebView 里根本打不开。
 *
 * 进度条仍压在顶边（播放条的核心信息，不属于「功能」）。
 * 没在播时也保留条本身（只显示一句空态），否则底部会突然塌掉。
 */
export function MobilePlayerBar() {
    const {t} = useTranslation();
    const {config} = useTheme();
    const navigate = useNavigate();
    const {pathname} = useLocation();
    const {current, detail, playing, elapsed, duration, playbackError} = usePlayerState();
    const {toggle, next, prev, seek, retryPlayback} = useActions().player;

    /* 封面优先用源侧详情（列表快照常常只有标题歌手） */
    const artwork = detail ?? current;
    const skin = config.components.playerBar.progressThumbSkin;
    const mainLabel = playbackError ? t('player.retry') : playing ? t('common.pause') : t('common.play');

    return (
        /* `data-drawer-swipe="off"`：这一条里有横向拖动的进度条，
           外壳的「横滑打开抽屉」手势必须跳过它（R137） */
        <section className={styles.bar} aria-label={t('mobile.openPlayer')} data-drawer-swipe="off">
            <div className={styles.seek}>
                <SeekBar
                    elapsed={elapsed}
                    duration={duration}
                    skin={skin}
                    onSeek={seek}
                    className={styles.seekBar}
                />
            </div>

            <div className={styles.row}>
                {/* 已在歌词页时不再压入一条重复历史（R141）：手机上播放条在歌词页也常驻，
                    每点一次就 push 一次会让「返回」要点同样多次才回得去。 */}
                <button
                    type="button"
                    className={styles.main}
                    onClick={() => {
                        if (shouldOpenNowPlaying(pathname)) navigate('/now-playing');
                    }}
                    aria-label={t('mobile.openPlayer')}
                >
                    <Cover
                        className={styles.cover}
                        artwork={artwork?.artwork}
                        gradient={artwork?.gradient}
                        title={current?.title ?? ''}
                        artist={current?.artist ?? ''}
                    />
                    <span className={styles.meta}>
                        <span className={styles.title}>{current ? current.title : t('miniPlayer.noTrack')}</span>
                        <span className={styles.artist}>{current ? current.artist : t('mobile.pickSong')}</span>
                    </span>
                </button>

                <button
                    type="button"
                    className={styles.control}
                    title={t('common.prev')}
                    aria-label={t('common.prev')}
                    onClick={prev}
                    disabled={!current}
                >
                    <IconPrev size={16}/>
                </button>

                <button
                    type="button"
                    className={styles.control}
                    title={mainLabel}
                    aria-label={mainLabel}
                    onClick={playbackError ? retryPlayback : toggle}
                    disabled={!current}
                >
                    {playing ? <IconPause size={16}/> : <IconPlay size={16}/>}
                </button>

                <button
                    type="button"
                    className={styles.control}
                    title={t('common.next')}
                    aria-label={t('common.next')}
                    onClick={next}
                    disabled={!current}
                >
                    <IconNext size={18}/>
                </button>
            </div>
        </section>
    );
}

export default MobilePlayerBar;
