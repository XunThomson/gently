import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {catalogService} from '../../services';
import {useActions, useSelect} from '../../store';
import type {Track} from '../../types';
import {TrackGrid} from './components/TrackGrid';

const RECOMMEND_LIMIT = 12;

/**
 * 热门推荐。
 * 顶栏有关键词时展示搜索结果，否则展示数据源推荐；两者共用同一份网格。
 */
export default function HotView() {
    const {t} = useTranslation();
    const query = useSelect((s) => s.ui.searchQuery);
    const {play} = useActions().player;

    const [tracks, setTracks] = useState<Track[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);

        const request = query.trim()
            ? catalogService.search(query.trim())
            : catalogService.fetchRecommend(RECOMMEND_LIMIT);

        request
            .then((result) => {
                if (!cancelled) setTracks(result);
            })
            .catch((err) => {
                console.error('[hot] 数据加载失败', err);
                if (!cancelled) setTracks([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [query]);

    return (
        <Page
            title={t('page.hot.title')}
            subtitle={query.trim() ? t('page.hot.searchResult', {keyword: query.trim()}) : t('page.hot.recommendSub')}
        >
            <TrackGrid tracks={tracks} loading={loading} onSelect={(track) => play(track, tracks)}/>
        </Page>
    );
}
