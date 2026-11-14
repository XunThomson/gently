import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useLocation, useNavigate} from 'react-router';
import {useActions, usePlayerState, useSelect} from '../../../store';
import {useTheme} from '../../../theme';
import {Cover} from '../../ui/cover';
import {IconHeart, IconMore, IconNext, IconPause, IconPlay} from '../../ui/icon';
import {SeekBar, shouldOpenNowPlaying} from '../player-bar';
import {MobilePlayerSheet} from './MobilePlayerSheet';
import styles from './MobilePlayerBar.module.css';

/**
 * 移动端常驻播放条（tab 之上、内容之下）。
 *
 * 与桌面 `PlayerBar` / 迷你播放器**共用同一批零件**（`Cover`、`SeekBar`、store 的
 * player 切片与 actions），只按手机宽度重排：进度条压在顶边，下面是
 * 「封面 + 标题/歌手 + 4 个功能位」。
 *
 * **功能位上限是 4 个**（用户反馈：手机宽度放不下更多，硬塞只会让每个都难点）：
 * 收藏 / 播放暂停 / 下一首 / 更多。上一首、随机、循环、定时关闭、音源、音质、
 * 队列、下载、加入歌单都在「更多」抽屉里；歌曲详情页也能用同一组播放模式。
 * 点主体进歌词页（`/now-playing`）。
 *
 * 没在播时也保留条本身（只显示一句空态）：否则底部会突然塌掉，tab 的手感会跳。
 */
export function MobilePlayerBar() {
    const {t} = useTranslation();
    const {config} = useTheme();
    const navigate = useNavigate();
    const {pathname} = useLocation();
    const {current, detail, playing, elapsed, duration, playbackError} = usePlayerState();
    const {toggle, next, seek, retryPlayback} = useActions().player;
    const {toggleFavorite} = useActions().collection;
    const isFavorite = useSelect(
        (s) =>
            !!s.player.current &&
            s.collection.favorites.some((track) => track.id === s.player.current?.id),
    );
    const [sheetOpen, setSheetOpen] = useState(false);

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
                {/* 已在歌词页时不再压入一条重复历史：手机上播放条在歌词页也常驻，
                    每点一次就 push 一次会让「返回」要点同样多次才回得去（R141）。 */}
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
                    title={isFavorite ? t('common.unfavorite') : t('common.favorite')}
                    aria-label={isFavorite ? t('common.unfavorite') : t('common.favorite')}
                    aria-pressed={isFavorite}
                    onClick={() => current && toggleFavorite(current)}
                    disabled={!current}
                >
                    <IconHeart size={16} fill={isFavorite ? 'currentColor' : 'none'}/>
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
                <button
                    type="button"
                    className={styles.control}
                    title={t('player.moreFunctions')}
                    aria-label={t('player.moreFunctions')}
                    aria-expanded={sheetOpen}
                    onClick={() => setSheetOpen(true)}
                    disabled={!current}
                >
                    <IconMore size={18}/>
                </button>
            </div>

            {sheetOpen && <MobilePlayerSheet onClose={() => setSheetOpen(false)}/>}
        </section>
    );
}

export default MobilePlayerBar;
