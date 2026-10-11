import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {EmptyState} from '../../components/ui/empty-state';
import {IconChevronLeft, IconMusic, IconPause, IconPlay} from '../../components/ui/icon';
import {Lyrics} from '../../components/ui/lyrics';
import {useActions, usePlayerState} from '../../store';
import {trackCoverStyle} from '../../utils/cover';
import styles from './now-playing.module.css';

/**
 * 歌词页。
 *
 * 歌曲信息（歌手 / 专辑 / 时长 / 来源）与功能性操作（收藏 / 下载 / 加入歌单）
 * 都在播放条与功能抽屉里，本页只负责「封面 + 歌词」这一件事。
 */
export default function NowPlayingView() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const {current, detail, playing, elapsed, lyrics} = usePlayerState();
    const {seek, toggle} = useActions().player;

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

    /* 封面优先用源侧详情（`catalog.track`）：列表快照常常只有标题歌手 */
    const artwork = detail ?? current;

    return (
        <div className={styles.page}>
            <button type="button" className={styles.back} onClick={() => navigate(-1)}>
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
                    <h2 className={styles.lyricsTitle}>{t('page.nowPlaying.lyrics')}</h2>
                    <Lyrics lines={lyrics} elapsed={elapsed} onSeek={seek}/>
                </section>
            </div>
        </div>
    );
}
