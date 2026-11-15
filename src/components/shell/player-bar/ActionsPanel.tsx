import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useLocation, useNavigate} from 'react-router';
import {Button} from '../../ui/button';
import {IconDownload, IconHeart, IconPlus} from '../../ui/icon';
import {QualityPicker} from './QualityPicker';
import {SourcePicker} from './SourcePicker';
import {useActions, usePlayerState, useSelect} from '../../../store';
import {downloadQueueKeyString, isQueued, parseQueueKeyString} from '../../../utils/downloadQueue';
import {shouldOpenNowPlaying} from '../../../utils/nowPlayingRoute';
import styles from './Panel.module.css';

/**
 * 功能抽屉：播放相关的功能性操作都收敛在这里
 * （收藏 / 下载 / 加入歌单 / 打开歌词页），避免占用歌词页与列表空间。
 */
export function ActionsPanel({
    onClose,
    inline = false,
    showDetail = true,
    showSourceQuality = false,
}: {
    onClose: () => void;
    inline?: boolean;
    /** 已经站在歌词页时不需要「打开歌曲详情」这颗按钮 */
    showDetail?: boolean;
    /** 窄窗播放条把音源/音质收进功能抽屉，保证这里仍有入口（R146） */
    showSourceQuality?: boolean;
}) {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const {pathname} = useLocation();
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
        <div
            className={`${styles.panel}${inline ? ` ${styles.panelInline}` : ''}`}
            role="dialog"
            aria-label={t('player.actions')}
        >
            {/* 内嵌进歌词页 tab 时不需要再顶一个「更多功能」标题：tab 本身就是标题 */}
            {!inline && (
                <div className={styles.head}>
                    <span className={styles.title}>{t('player.actions')}</span>
                </div>
            )}

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

                {showDetail && (
                    <Button
                        size="sm"
                        variant="default"
                        disabled={!current}
                        onClick={() => {
                            onClose();
                            if (shouldOpenNowPlaying(pathname)) navigate('/now-playing');
                        }}
                    >
                        {t('player.openDetail')}
                    </Button>
                )}
            </div>

            {showSourceQuality && (
                <div className={styles.section}>
                    <span className={styles.sectionLabel}>{t('source.label')}</span>
                    <div className={styles.pickers}>
                        <SourcePicker/>
                        <QualityPicker/>
                    </div>
                </div>
            )}

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
