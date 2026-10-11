import {useEffect} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {AlbumGrid} from '../../components/ui/album-grid';
import {EmptyState} from '../../components/ui/empty-state';
import {Page} from '../../components/ui/page';
import {PlaylistGrid} from '../../components/ui/playlist-grid';
import {SectionHeader} from '../../components/ui/section-header';
import {useActions, usePluginState, useRecommendState, useSelect} from '../../store';
import type {Album, CuratedPlaylist, RecommendedTrack} from '../../types';
import {topTags} from '../../utils/taste';
import {TrackGrid} from './components/TrackGrid';
import styles from './hot.module.css';

/** 详情页路径：源与 id 都要编码（源的 id 与 id 里可能带 `:` 等字符） */
const collectionPath = (kind: 'album' | 'curated', item: Album | CuratedPlaylist): string =>
    `/collection/${kind}/${encodeURIComponent(item.source)}/${encodeURIComponent(item.id)}`;

/**
 * 推荐页：个性化推荐的聚合页，不再只是单曲列表。
 *
 * - 单曲 / 专辑 / 歌单三个区块，全部由口味画像打分排序；
 * - 每个条目带可解释的推荐理由（因为你听过 X / 因为你喜欢某标签）；
 * - **「不感兴趣」直接给画像负反馈**（`recommend.feedback{skip, progress:0}`）：
 *   听完一半就切走这种信号核心看不到，显式表态是唯一能让推荐变准的办法；
 * - 另有一栏**源侧推荐**（`catalog.recommend`）：当前音源自己的推荐，与本机画像并列
 *   （插件知道它的榜单与热度，是本机算不出来的）；
 * - 画像来自最近播放（时间衰减 + 播放次数）与收藏，样本不足时回落「近期热门」。
 */
export default function HotView() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const {bundle, loading, loaded, sourceTracks, sourceId, sourceLoading} = useRecommendState();
    const {load, loadSource, dislike} = useActions().recommend;
    const {playOrToggle} = useActions().player;
    const currentId = useSelect((s) => s.player.current?.id ?? null);
    const playing = useSelect((s) => s.player.playing);
    const pluginList = usePluginState().list;

    useEffect(() => {
        // 首次进入时先确保本地库（画像输入）就绪，再生成推荐；源侧推荐与它并行
        void load();
        void loadSource();
    }, [load, loadSource]);

    const sourceName = pluginList.find((plugin) => plugin.id === sourceId)?.name ?? sourceId ?? '';

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
                    currentId={currentId}
                    playing={playing}
                    reasonOf={(track) => (track as RecommendedTrack).reason}
                    onDislike={dislike}
                    onSelect={(track) => playOrToggle(track, tracks)}
                />
            </section>

            {/* 源侧推荐：源可能没有实现 getRecommend（能力探测）或跑挂 → 直接不显示这一栏 */}
            {(sourceLoading || sourceTracks.length > 0) && (
                <section className={styles.section}>
                    <SectionHeader
                        title={t('recommend.sourceTitle')}
                        subtitle={t('recommend.sourceSubtitle', {source: sourceName})}
                    />
                    <TrackGrid
                        tracks={sourceTracks}
                        loading={sourceLoading}
                        currentId={currentId}
                        playing={playing}
                        onDislike={dislike}
                        onSelect={(track) => playOrToggle(track, sourceTracks)}
                    />
                </section>
            )}

            <section className={styles.section}>
                <SectionHeader
                    title={t('recommend.albumsTitle')}
                    subtitle={t('recommend.albumsSubtitle')}
                />
                <AlbumGrid
                    albums={albums}
                    /* 点卡片 → 看详情（完整曲目在详情页）；封面上的播放按钮直接播 */
                    onSelect={(album) => navigate(collectionPath('album', album))}
                    onPlay={(album) => album.tracks[0] && playOrToggle(album.tracks[0], album.tracks)}
                />
            </section>

            <section className={styles.section}>
                <SectionHeader
                    title={t('recommend.playlistsTitle')}
                    subtitle={t('recommend.playlistsSubtitle')}
                />
                <PlaylistGrid
                    playlists={playlists}
                    onSelect={(playlist) => navigate(collectionPath('curated', playlist))}
                    onPlay={(playlist) => playOrToggle(playlist.tracks[0], playlist.tracks)}
                />
            </section>
        </Page>
    );
}
