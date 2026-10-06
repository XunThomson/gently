import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {appConfig} from '../../config/app.config';
import {catalogService} from '../../services';
import {useActions, useSelect} from '../../store';
import type {Track} from '../../types';
import {TrackGrid} from './components/TrackGrid';

/** 热门推荐：只负责推荐，搜索结果已经独立为 /search 视图。 */
export default function HotView() {
    const {t} = useTranslation();
    const currentId = useSelect((s) => s.player.current?.id ?? null);
    const playing = useSelect((s) => s.player.playing);
    const {playOrToggle} = useActions().player;

    const [tracks, setTracks] = useState<Track[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);

        catalogService
            .fetchRecommend(appConfig.list.recommendLimit)
            .then((result) => {
                if (!cancelled) setTracks(result);
            })
            .catch((err) => {
                console.error('[hot] 推荐加载失败', err);
                if (!cancelled) setTracks([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, []);

    return (
        <Page title={t('page.hot.title')} subtitle={t('page.hot.recommendSub')}>
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
