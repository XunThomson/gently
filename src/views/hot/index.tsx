import {useEffect} from 'react';
import {useTranslation} from 'react-i18next';
import {AlbumGrid} from '../../components/ui/album-grid';
import {EmptyState} from '../../components/ui/empty-state';
import {Page} from '../../components/ui/page';
import {PlaylistGrid} from '../../components/ui/playlist-grid';
import {SectionHeader} from '../../components/ui/section-header';
import {useActions, useRecommendState} from '../../store';
import type {RecommendedTrack} from '../../types';
import {topTags} from '../../utils/recommend';
import {TrackGrid} from './components/TrackGrid';
import styles from './hot.module.css';

/**
 * 推荐页：个性化推荐的聚合页，不再只是单曲列表。
 *
 * - 单曲 / 专辑 / 歌单三个区块，全部由口味画像打分排序；
 * - 每个条目带可解释的推荐理由（因为你听过 X / 因为你喜欢某标签）；
 * - 画像来自最近播放（时间衰减 + 播放次数）与收藏，样本不足时回落「近期热门」。
 */
export default function HotView() {
    const {t} = useTranslation();
    const {bundle, loading, loaded} = useRecommendState();
    const {load} = useActions().recommend;
    const {playOrToggle} = useActions().player;

    useEffect(() => {
        // 首次进入时先确保本地库（画像输入）就绪，再生成推荐
        void load();
    }, [load]);

    if (!bundle) {
        return (
            <Page title={t('page.hot.title')} subtitle={t('page.hot.recommendSub')}>
                <EmptyState title={loading || !loaded ? t('common.loading') : t('recommend.profileEmpty')}/>
            </Page>
        );
    }

    const {profile, tracks, albums, playlists} = bundle;
    const tags = topTags(profile, 3);
    const profileText = tags.length > 0 ? tags.join(' · ') : t('recommend.profileEmpty');

    return (
        <Page
            title={t('page.hot.title')}
            subtitle={t('page.hot.recommendSub')}
            toolbar={
                <span className={styles.profile} title={t('recommend.profile')}>
                    <span className={styles.profileLabel}>{t('recommend.profile')}</span>
                    <span className={styles.profileValue}>{profileText}</span>
                </span>
            }
        >
            <section className={styles.section}>
                <SectionHeader
                    title={t('recommend.tracksTitle')}
                    subtitle={t('recommend.tracksSubtitle')}
                />
                <TrackGrid
                    tracks={tracks}
                    loading={loading}
                    reasonOf={(track) => (track as RecommendedTrack).reason}
                    onSelect={(track) => playOrToggle(track, tracks)}
                />
            </section>

            <section className={styles.section}>
                <SectionHeader
                    title={t('recommend.albumsTitle')}
                    subtitle={t('recommend.albumsSubtitle')}
                />
                <AlbumGrid
                    albums={albums}
                    onSelect={(album) => album.tracks[0] && playOrToggle(album.tracks[0], album.tracks)}
                    onPlay={(album) => playOrToggle(album.tracks[0], album.tracks)}
                />
            </section>

            <section className={styles.section}>
                <SectionHeader
                    title={t('recommend.playlistsTitle')}
                    subtitle={t('recommend.playlistsSubtitle')}
                />
                <PlaylistGrid
                    playlists={playlists}
                    onSelect={(playlist) =>
                        playlist.tracks[0] && playOrToggle(playlist.tracks[0], playlist.tracks)
                    }
                    onPlay={(playlist) => playOrToggle(playlist.tracks[0], playlist.tracks)}
                />
            </section>
        </Page>
    );
}
