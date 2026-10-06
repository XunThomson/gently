import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {useActions, useRankingState} from '../../store';
import {formatRange, toDateKey} from '../../utils/date';
import {hashStr} from '../../utils/helpers';
import {rankedTracks} from '../../utils/track';
import {ChartSection} from './components/ChartSection';
import {HeroCard} from './components/HeroCard';

/**
 * 排行榜视图：今日推荐 + 榜单区块。
 * 榜单数据与查询条件集中在 store 的 ranking 切片。
 */
export default function RankingView() {
    const {t} = useTranslation();
    const {period, date, weekStart, rows} = useRankingState();
    const {play} = useActions().player;

    const dateKey = toDateKey(period, date, weekStart);
    const hero = rows[0];

    const playHero = () => {
        if (!hero) return;
        const tracks = rankedTracks(rows, hashStr(dateKey), 'ranking');
        play(tracks[0], tracks);
    };

    return (
        <Page
            title={t('page.ranking.title')}
            subtitle={`${formatRange(period, date, weekStart)} · ${t('page.ranking.subtitle')}`}
        >
            <HeroCard song={hero} onPlay={playHero}/>
            <ChartSection/>
        </Page>
    );
}
