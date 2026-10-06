import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {Button} from '../../../components/ui/button';
import {IconChevronDown} from '../../../components/ui/icon';
import {SectionHeader} from '../../../components/ui/section-header';
import {appConfig} from '../../../config/app.config';
import {useActions, useRankingState, useSelect} from '../../../store';
import {formatRange, toDateKey} from '../../../utils/date';
import {hashStr, matchesQuery} from '../../../utils/helpers';
import {rankedTracks, type RankedTrack} from '../../../utils/track';
import type {ChartType, Period} from '../../../types';
import {ChartList} from './ChartList';
import {DatePicker} from './DatePicker';
import styles from './ChartSection.module.css';

const CHART_TYPES: ChartType[] = ['hot', 'new', 'rise', 'origin'];
const PERIODS: Period[] = ['day', 'week', 'month', 'year'];
const DEFAULT_VISIBLE = appConfig.list.chartVisible;

/**
 * 榜单区块：查询条件（榜单类型 / 周期 / 时间）与列表。
 * 状态全部来自集中式 store，本组件只负责渲染与派发命令。
 */
export function ChartSection() {
    const {t} = useTranslation();
    const ranking = useRankingState();
    /* 只订阅「正在播放哪一首」，避免每秒进度更新触发榜单重渲染 */
    const currentKey = useSelect((s) =>
        s.player.current ? `${s.player.current.title}|${s.player.current.artist}` : null,
    );
    /* 音源筛选变化后需要重新拉取榜单 */
    const sourceFilter = useSelect((s) => s.ui.sourceFilter);
    const {setChart, setPeriod, setDate, toggleExpanded, load} = useActions().ranking;
    const {playOrToggle} = useActions().player;

    useEffect(() => {
        void load();
    }, [load, sourceFilter]);

    const {chart, period, date, weekStart, expanded, query, rows, loading} = ranking;

    const dateKey = toDateKey(period, date, weekStart);
    const rangeText = formatRange(period, date, weekStart);

    const filtered = useMemo(
        () => rows.filter((row) => matchesQuery(row.title, row.artist, query)),
        [rows, query],
    );

    const total = filtered.length;
    const visibleRows = expanded ? filtered : filtered.slice(0, DEFAULT_VISIBLE);
    const remaining = total - DEFAULT_VISIBLE;

    /* 榜单行 → 可播放曲目：与列表一一对应，点行即播放 */
    const seed = useMemo(() => hashStr(dateKey), [dateKey]);
    const tracks = useMemo(() => rankedTracks(visibleRows, seed, chart), [visibleRows, seed, chart]);

    const hint = !total
        ? null
        : total <= DEFAULT_VISIBLE
            ? t('page.ranking.total', {count: total})
            : expanded
                ? t('page.ranking.all', {count: total})
                : t('page.ranking.top', {count: DEFAULT_VISIBLE, total});

    const handleSelect = (track: RankedTrack) => playOrToggle(track, tracks);

    return (
        <section className={styles.section}>
            <SectionHeader
                title={t('page.ranking.title')}
                subtitle={rangeText}
                extra={
                    <div className={styles.tabs}>
                        {CHART_TYPES.map((key) => (
                            <button
                                key={key}
                                type="button"
                                className={`${styles.tab}${chart === key ? ` ${styles.active}` : ''}`}
                                onClick={() => setChart(key)}
                            >
                                {t(`page.ranking.chart.${key}`)}
                            </button>
                        ))}
                    </div>
                }
            />

            <div className={styles.timeBar}>
                <div className={styles.timeGroup}>
                    <div className={styles.periodChips}>
                        {PERIODS.map((key) => (
                            <button
                                key={key}
                                type="button"
                                className={`${styles.chip}${period === key ? ` ${styles.chipActive}` : ''}`}
                                onClick={() => setPeriod(key)}
                            >
                                {t(`page.ranking.period.${key}`)}
                            </button>
                        ))}
                    </div>

                    <div className={styles.divider}/>

                    {period === 'week' ? (
                        /* 周榜只需要「本周」这一个信息，不需要上一周列表 */
                        <span className={styles.weekChip}>
                            {t('page.ranking.thisWeek')}
                            <em>{rangeText}</em>
                        </span>
                    ) : (
                        <DatePicker period={period} date={date} onChange={setDate}/>
                    )}
                </div>

                {hint && <span className={styles.hint}>{hint}</span>}
            </div>

            <div className={styles.card}>
                <ChartList
                    rows={tracks}
                    loading={loading}
                    currentTitle={currentKey}
                    onSelect={handleSelect}
                />

                {remaining > 0 && (
                    <div className={styles.foot}>
                        <Button
                            variant="ghost"
                            className={styles.loadMore}
                            onClick={toggleExpanded}
                            icon={
                                <IconChevronDown
                                    size={14}
                                    className={expanded ? styles.chevUp : undefined}
                                />
                            }
                        >
                            {expanded
                                ? t('common.collapse')
                                : t('page.ranking.showAll', {count: remaining})}
                        </Button>
                    </div>
                )}
            </div>
        </section>
    );
}

export default ChartSection;
