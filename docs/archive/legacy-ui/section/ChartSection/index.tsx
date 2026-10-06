import { useMemo, type ReactNode } from 'react';
import ChartTabs from './ChartTabs';
import TimeBar from './TimeBar';
import ChartList from './ChartList';
import styles from './ChartSection.module.css';

import { DEFAULT_VISIBLE } from '../../../constants';
import { hashStr, matchesQuery } from '../../../utils/helpers';

import type {
    ChartType,
    DateSelection,
    NowPlaying,
    Period,
    SongRow,
} from '../../../types';

interface Props {
    chart: ChartType;
    period: Period;
    date: DateSelection;
    weekStart: DateSelection;
    expanded: boolean;
    query: string;
    rows: SongRow[];
    dateKey: string;
    rangeText: string;
    current: NowPlaying | null;
    onChartChange: (chart: ChartType) => void;
    onPeriodChange: (period: Period) => void;
    onDateChange: (date: DateSelection) => void;
    onWeekChange: (weekStart: DateSelection) => void;
    onToggleExpand: () => void;
    onSelect: (song: SongRow, gradient: string) => void;
}

export default function ChartSection({
                                         chart,
                                         period,
                                         date,
                                         weekStart,
                                         expanded,
                                         query,
                                         rows,
                                         dateKey,
                                         rangeText,
                                         current,
                                         onChartChange,
                                         onPeriodChange,
                                         onDateChange,
                                         onWeekChange,
                                         onToggleExpand,
                                         onSelect,
                                     }: Props) {
    const filtered = useMemo(
        () => rows.filter((r) => matchesQuery(r.title, r.artist, query)),
        [rows, query],
    );

    const total = filtered.length;
    const showCount = expanded ? total : Math.min(DEFAULT_VISIBLE, total);
    const visible = useMemo(() => filtered.slice(0, showCount), [filtered, showCount]);
    const seed = useMemo(() => hashStr(dateKey), [dateKey]);

    let hint: ReactNode = null;
    if (total > 0) {
        if (total <= DEFAULT_VISIBLE) hint = <>共 <b>{total}</b> 首</>;
        else if (expanded) hint = <>已展示全部 <b>{total}</b> 首</>;
        else hint = <>Top <b>{showCount}</b> · 共 <b>{total}</b> 首</>;
    }

    return (
        <section className={styles.section}>
            <div className={styles.sectionHead}>
                <h2>
                    排行榜 <span className={styles.sub}>{rangeText}</span>
                </h2>
                <ChartTabs value={chart} onChange={onChartChange} />
            </div>

            <TimeBar
                period={period}
                date={date}
                weekStart={weekStart}
                hint={hint}
                onPeriodChange={onPeriodChange}
                onDateChange={onDateChange}
                onWeekChange={onWeekChange}
            />

            <div className={styles.chartCard}>
                <ChartList rows={visible} seed={seed} current={current} onSelect={onSelect} />

                {total > DEFAULT_VISIBLE && (
                    <div className={styles.chartFoot}>
                        <button
                            className={`${styles.loadMore}${expanded ? ` ${styles.expanded}` : ''}`}
                            onClick={onToggleExpand}
                        >
                            <span>{expanded ? '收起列表' : `查看剩余 ${total - DEFAULT_VISIBLE} 首`}</span>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                <path
                                    d="M6 9l6 6 6-6"
                                    stroke="currentColor"
                                    strokeWidth="2.2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />
                            </svg>
                        </button>
                    </div>
                )}
            </div>
        </section>
    );
}