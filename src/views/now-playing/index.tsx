import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {Button} from '../../components/ui/button';
import {EmptyState} from '../../components/ui/empty-state';
import {IconChevronLeft, IconDownload, IconHeart, IconMusic, IconPlus} from '../../components/ui/icon';
import {Lyrics} from '../../components/ui/lyrics';
import {useActions, usePlayerState, useSelect} from '../../store';
import styles from './now-playing.module.css';

/**
 * 歌曲详情（含歌词）。
 * 歌词与播放进度同源（player 切片），点击歌词行可直接跳转播放位置。
 */
export default function NowPlayingView() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const player = usePlayerState();
    const {seek, toggle} = useActions().player;
    const {toggleFavorite, createPlaylist, addToPlaylist, load} = useActions().collection;
    const {add: addDownload} = useActions().download;

    const playlists = useSelect((s) => s.collection.playlists);
    const isFavorite = useSelect(
        (s) =>
            !!s.player.current &&
            s.collection.favorites.some((track) => track.id === s.player.current?.id),
    );

    const [toast, setToast] = useState('');

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (!toast) return;
        const id = window.setTimeout(() => setToast(''), 2000);
        return () => window.clearTimeout(id);
    }, [toast]);

    const {current, playing, elapsed, lyrics} = player;

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

    const addTo = (playlistId: string, name: string) => {
        addToPlaylist(playlistId, current);
        setToast(t('page.nowPlaying.addedToPlaylist', {name}));
    };

    const createAndAdd = () => {
        const playlist = createPlaylist(`${current.artist} 的歌单`);
        addTo(playlist.id, playlist.name);
    };

    return (
        <div className={styles.page}>
            <button type="button" className={styles.back} onClick={() => navigate(-1)}>
                <IconChevronLeft size={16}/>
                {t('common.back')}
            </button>

            <div className={styles.layout}>
                {/* ---------- 左：封面与信息 ---------- */}
                <section className={styles.detail}>
                    <div className={styles.cover} style={{background: current.gradient}}>
                        <span className={styles.coverInitial}>{current.title.slice(0, 1)}</span>
                        <button
                            type="button"
                            className={styles.coverPlay}
                            aria-label={playing ? t('common.pause') : t('common.play')}
                            onClick={toggle}
                        >
                            {playing ? '❚❚' : '▶'}
                        </button>
                    </div>

                    <h1 className={styles.title}>{current.title}</h1>
                    <p className={styles.sub}>
                        {current.artist} · {current.album}
                    </p>

                    <dl className={styles.metaList}>
                        <div>
                            <dt>{t('column.duration')}</dt>
                            <dd>{current.duration}</dd>
                        </div>
                        <div>
                            <dt>{t('column.source')}</dt>
                            <dd>{current.source}</dd>
                        </div>
                    </dl>

                    <div className={styles.actions}>
                        <Button
                            variant={isFavorite ? 'primary' : 'default'}
                            icon={<IconHeart size={15} fill={isFavorite ? 'currentColor' : 'none'}/>}
                            onClick={() => toggleFavorite(current)}
                        >
                            {isFavorite ? t('common.unfavorite') : t('common.favorite')}
                        </Button>
                        <Button
                            variant="default"
                            icon={<IconDownload size={15}/>}
                            onClick={() => addDownload(current)}
                        >
                            {t('common.download')}
                        </Button>
                    </div>

                    {/* ---------- 加入歌单 ---------- */}
                    <div className={styles.playlists}>
                        <span className={styles.playlistsLabel}>
                            {t('page.playlist.addToPlaylist')}
                        </span>
                        <div className={styles.chips}>
                            {playlists.map((playlist) => (
                                <button
                                    key={playlist.id}
                                    type="button"
                                    className={styles.chip}
                                    onClick={() => addTo(playlist.id, playlist.name)}
                                >
                                    {playlist.name}
                                </button>
                            ))}
                            <button
                                type="button"
                                className={`${styles.chip} ${styles.chipNew}`}
                                onClick={createAndAdd}
                            >
                                <IconPlus size={12}/>
                                {t('page.playlist.create')}
                            </button>
                        </div>
                        {toast && <p className={styles.toast}>{toast}</p>}
                    </div>
                </section>

                {/* ---------- 右：歌词 ---------- */}
                <section className={styles.lyricsPanel}>
                    <h2 className={styles.lyricsTitle}>{t('page.nowPlaying.lyrics')}</h2>
                    <Lyrics lines={lyrics} elapsed={elapsed} onSeek={seek}/>
                </section>
            </div>
        </div>
    );
}
