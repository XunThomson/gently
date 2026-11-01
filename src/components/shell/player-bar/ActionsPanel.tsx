import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {Button} from '../../ui/button';
import {IconDownload, IconHeart, IconPlus} from '../../ui/icon';
import {useActions, usePlayerState, useSelect} from '../../../store';
import {downloadQueueKeyString, isQueued, parseQueueKeyString} from '../../../utils/downloadQueue';
import styles from './Panel.module.css';

/**
 * 功能抽屉：播放相关的功能性操作都收敛在这里
 * （收藏 / 下载 / 加入歌单 / 打开歌词页），避免占用歌词页与列表空间。
 */
export function ActionsPanel({onClose}: { onClose: () => void }) {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const {current} = usePlayerState();
    const {toggleFavorite, createPlaylist, addToPlaylist} = useActions().collection;
    const {add: addDownload} = useActions().download;
    const playlists = useSelect((s) => s.collection.playlists);
    const isFavorite = useSelect(
        (s) =>
            !!s.player.current &&
            s.collection.favorites.some((track) => track.id === s.player.current?.id),
    );
    /* 已在下载队列里的曲目不再给下载入口（与 `useTrackActions` 同一套判定） */
    const queueKeys = useSelect((s) => downloadQueueKeyString(s.download.tasks));
    const canDownloadCurrent = !!current && !isQueued(parseQueueKeyString(queueKeys), current);

    const [toast, setToast] = useState('');

    const addTo = (playlistId: string, name: string) => {
        if (!current) return;
        addToPlaylist(playlistId, current);
        setToast(t('page.nowPlaying.addedToPlaylist', {name}));
    };

    return (
        <div className={styles.panel} role="dialog" aria-label={t('player.actions')}>
            <div className={styles.head}>
                <span className={styles.title}>{t('player.actions')}</span>
            </div>

            <div className={styles.actions}>
                <Button
                    size="sm"
                    variant={isFavorite ? 'primary' : 'default'}
                    disabled={!current}
                    icon={<IconHeart size={14} fill={isFavorite ? 'currentColor' : 'none'}/>}
                    onClick={() => current && toggleFavorite(current)}
                >
                    {isFavorite ? t('common.unfavorite') : t('common.favorite')}
                </Button>

                <Button
                    size="sm"
                    variant="default"
                    disabled={!current || !canDownloadCurrent}
                    icon={<IconDownload size={14}/>}
                    onClick={() => current && addDownload(current)}
                >
                    {t('common.download')}
                </Button>

                <Button
                    size="sm"
                    variant="default"
                    disabled={!current}
                    onClick={() => {
                        onClose();
                        navigate('/now-playing');
                    }}
                >
                    {t('player.openDetail')}
                </Button>
            </div>

            <div className={styles.section}>
                <span className={styles.sectionLabel}>{t('page.playlist.addToPlaylist')}</span>
                <div className={styles.chips}>
                    {playlists.map((playlist) => (
                        <button
                            key={playlist.id}
                            type="button"
                            className={styles.chip}
                            disabled={!current}
                            onClick={() => addTo(playlist.id, playlist.name)}
                        >
                            {playlist.name}
                        </button>
                    ))}

                    <button
                        type="button"
                        className={`${styles.chip} ${styles.chipNew}`}
                        disabled={!current}
                        onClick={() => {
                            if (!current) return;
                            // 曲目**必须**在建的时候一起交给核心：占位 id 核心不认识，
                            // 「先建、再补写」会静默失败（R40 实测：提示「已加入」但歌单是空的）
                            const playlist = createPlaylist(`${current.artist} 的歌单`, [current]);
                            setToast(t('page.nowPlaying.addedToPlaylist', {name: playlist.name}));
                        }}
                    >
                        <IconPlus size={12}/>
                        {t('page.playlist.create')}
                    </button>
                </div>
                {toast && <p className={styles.toast}>{toast}</p>}
            </div>
        </div>
    );
}

export default ActionsPanel;
