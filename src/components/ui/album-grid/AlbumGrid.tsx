import type {JSX, KeyboardEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {EmptyState} from '../../../components/ui/empty-state';
import {IconPlay} from '../../../components/ui/icon';
import type {RecommendedAlbum} from '../../../types';
import {coverStyle} from '../../../utils/cover';
import {ReasonChip} from '../reason-chip';
import styles from './AlbumGrid.module.css';

export interface AlbumGridProps {
    /** 带推荐理由的专辑 */
    albums: RecommendedAlbum[];
    /** 点击卡片 */
    onSelect: (album: RecommendedAlbum) => void;
    /** 点击封面上的播放按钮 */
    onPlay: (album: RecommendedAlbum) => void;
}

/**
 * 推荐专辑卡片网格。
 *
 * 卡片本体是 `div[role=button]`（键盘可达），播放按钮是它内部独立的 `<button>`，
 * 两者不嵌套，避免按钮套按钮。
 */
export function AlbumGrid({albums, onSelect, onPlay}: AlbumGridProps): JSX.Element {
    const {t} = useTranslation();

    if (albums.length === 0) {
        return <EmptyState title={t('recommend.profileEmpty')}/>;
    }

    const activate = (event: KeyboardEvent<HTMLDivElement>, album: RecommendedAlbum) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect(album);
    };

    return (
        <div className={styles.grid}>
            {albums.map((album) => (
                <div
                    key={album.id}
                    role="button"
                    tabIndex={0}
                    className={styles.card}
                    onClick={() => onSelect(album)}
                    onKeyDown={(event) => activate(event, album)}
                >
                    <span
                        className={styles.cover}
                        style={coverStyle(album.cover, `${album.source}|${album.title}`)}
                    >
                        <span className={styles.initial}>{album.title.slice(0, 1)}</span>
                        <button
                            type="button"
                            className={styles.play}
                            aria-label={t('common.play')}
                            onClick={(event) => {
                                event.stopPropagation();
                                onPlay(album);
                            }}
                            onKeyDown={(event) => event.stopPropagation()}
                        >
                            <IconPlay size={12}/>
                        </button>
                    </span>
                    <span className={styles.title}>{album.title}</span>
                    <ReasonChip reason={album.reason} className={styles.reason}/>
                    <span className={styles.artist}>{album.artist}</span>
                    <span className={styles.meta}>
                        {t('recommend.trackCount', {count: album.tracks.length})} · {album.year}
                    </span>
                </div>
            ))}
        </div>
    );
}

export default AlbumGrid;
