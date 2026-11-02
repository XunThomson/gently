import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {useActions, usePlayerState} from '../../../store';
import {useTheme} from '../../../theme';
import {Cover} from '../../ui/cover';
import {IconNext, IconPause, IconPlay} from '../../ui/icon';
import {SeekBar} from '../player-bar';
import styles from './MobilePlayerBar.module.css';

/**
 * 移动端常驻播放条（tab 之上、内容之下）。
 *
 * 与桌面 `PlayerBar` / 迷你播放器**共用同一批零件**（`Cover`、`SeekBar`、store 的
 * player 切片与 actions），只按手机宽度重排：进度条压在顶边，下面是
 * 「封面 + 标题/歌手 + 播放/下一首」。点主体进歌词页（`/now-playing`）。
 *
 * 没在播时也保留条本身（只显示一句空态）：否则底部会突然塌掉，tab 的手感会跳。
 */
export function MobilePlayerBar() {
    const {t} = useTranslation();
    const {config} = useTheme();
    const navigate = useNavigate();
    const {current, detail, playing, elapsed, duration, playbackError} = usePlayerState();
    const {toggle, next, seek, retryPlayback} = useActions().player;

    /* 封面优先用源侧详情（列表快照常常只有标题歌手） */
    const artwork = detail ?? current;
    const skin = config.components.playerBar.progressThumbSkin;
    const mainLabel = playbackError ? t('player.retry') : playing ? t('common.pause') : t('common.play');

    return (
        /* `data-drawer-swipe="off"`：这一条里有横向拖动的进度条，
           外壳的「横滑打开抽屉」手势必须跳过它（R137） */
        <section className={styles.bar} aria-label={t('mobile.openPlayer')} data-drawer-swipe="off">
            <div className={styles.seek}>
                <SeekBar elapsed={elapsed} duration={duration} skin={skin} onSeek={seek}/>
            </div>

            <div className={styles.row}>
                <button
                    type="button"
                    className={styles.main}
                    onClick={() => navigate('/now-playing')}
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
