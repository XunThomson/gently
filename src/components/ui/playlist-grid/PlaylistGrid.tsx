import type {JSX, KeyboardEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {EmptyState} from '../../../components/ui/empty-state';
import {IconPlay} from '../../../components/ui/icon';
import type {RecommendedPlaylist} from '../../../types';
import {ReasonChip} from '../reason-chip';
import styles from './PlaylistGrid.module.css';

export interface PlaylistGridProps {
    /** 带推荐理由的编辑精选歌单 */
    playlists: RecommendedPlaylist[];
    /** 点击卡片 */
    onSelect: (playlist: RecommendedPlaylist) => void;
    /** 点击封面上的播放按钮 */
    onPlay: (playlist: RecommendedPlaylist) => void;
}

/**
 * 编辑精选歌单卡片网格。
 *
 * 与专辑网格同样：卡片本体是 `div[role=button]`，播放按钮是内部独立的 `<button>`，
 * 两者不嵌套。
 */
export function PlaylistGrid({playlists, onSelect, onPlay}: PlaylistGridProps): JSX.Element {
    const {t} = useTranslation();

    if (playlists.length === 0) {
        return <EmptyState title={t('recommend.profileEmpty')}/>;
    }

    const activate = (event: KeyboardEvent<HTMLDivElement>, playlist: RecommendedPlaylist) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect(playlist);
    };

    return (
        <div className={styles.grid}>
            {playlists.map((playlist) => (
                <div
                    key={playlist.id}
                    role="button"
                    tabIndex={0}
                    className={styles.card}
                    onClick={() => onSelect(playlist)}
                    onKeyDown={(event) => activate(event, playlist)}
                >
                    <span className={styles.cover} style={{background: playlist.cover}}>
                        <span className={styles.initial}>{playlist.title.slice(0, 1)}</span>
                        <button
                            type="button"
                            className={styles.play}
                            aria-label={t('common.play')}
                            onClick={(event) => {
                                event.stopPropagation();
                                onPlay(playlist);
                            }}
                            onKeyDown={(event) => event.stopPropagation()}
                        >
                            <IconPlay size={12}/>
                        </button>
                    </span>
                    <span className={styles.title}>{playlist.title}</span>
                    <ReasonChip reason={playlist.reason} className={styles.reason}/>
                    <span className={styles.description}>{playlist.description}</span>
                    <span className={styles.meta}>
                        {t('recommend.trackCount', {count: playlist.tracks.length})}
                    </span>
                    {playlist.tags.length > 0 && (
                        <span className={styles.tags}>
                            {playlist.tags.map((tag) => (
                                <span key={tag} className={styles.tag}>
                                    {tag}
                                </span>
                            ))}
                        </span>
                    )}
                </div>
            ))}
        </div>
    );
}

export default PlaylistGrid;
