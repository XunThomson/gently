import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {SourceFilter} from '../../components/ui/source-filter';
import {appConfig} from '../../config/app.config';
import {catalogService} from '../../services';
import {useActions, useSelect} from '../../store';
import type {GroupedTrack} from '../../types';
import {filterGroupsBySource} from '../../utils/track';
import {TrackGrid} from './components/TrackGrid';

/**
 * 热门推荐：只负责推荐，搜索结果已经独立为 /search 视图。
 * 音源默认聚合（同一首歌只出现一次），可切换为分源。
 */
export default function HotView() {
    const {t} = useTranslation();
    const currentId = useSelect((s) => s.player.current?.id ?? null);
    const playing = useSelect((s) => s.player.playing);
    const display = useSelect((s) => s.ui.sourceDisplay);
    const sourceFilter = useSelect((s) => s.ui.sourceFilter);
    const {playOrToggle} = useActions().player;

    const [groups, setGroups] = useState<GroupedTrack[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);

        const request =
            display === 'aggregate'
                ? catalogService.fetchRecommendAll(appConfig.list.recommendLimit)
                : catalogService
                      .fetchRecommendFrom(
                          appConfig.list.recommendLimit,
                          sourceFilter === 'all' ? undefined : sourceFilter,
                      )
                      .then((tracks) => tracks as GroupedTrack[]);

        request
            .then((result) => {
                if (!cancelled) setGroups(result);
            })
            .catch((err) => {
                console.error('[hot] 推荐加载失败', err);
                if (!cancelled) setGroups([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [display, sourceFilter]);

    const tracks = useMemo(
        () => (display === 'aggregate' ? filterGroupsBySource(groups, sourceFilter) : groups),
        [groups, display, sourceFilter],
    );

    return (
        <Page
            title={t('page.hot.title')}
            subtitle={t('page.hot.recommendSub')}
            toolbar={<SourceFilter/>}
        >
            <TrackGrid
                tracks={tracks}
                loading={loading}
                currentId={currentId}
                playing={playing}
                onSelect={(track) => playOrToggle(track, tracks)}
            />
        </Page>
    );
}
