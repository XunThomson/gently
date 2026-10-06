import type { ReactNode } from 'react';
import DatePicker from './DatePicker';
import WeekChips from './WeekChips';
import styles from './TimeBar.module.css';
import type { DateSelection, Period } from '../../../types';

const PERIODS: { key: Period; label: string }[] = [
    { key: 'day', label: '日榜' },
    { key: 'week', label: '周榜' },
    { key: 'month', label: '月榜' },
    { key: 'year', label: '年榜' },
];

interface Props {
    period: Period;
    date: DateSelection;
    weekStart: DateSelection;
    hint: ReactNode;
    onPeriodChange: (period: Period) => void;
    onDateChange: (date: DateSelection) => void;
    onWeekChange: (weekStart: DateSelection) => void;
}

export default function TimeBar({
                                    period,
                                    date,
                                    weekStart,
                                    hint,
                                    onPeriodChange,
                                    onDateChange,
                                    onWeekChange,
                                }: Props) {
    return (
        <div className={styles.timeBar}>
            <div className={styles.timeGroup}>
                <div className={`${styles.timeChips} ${styles.period}`}>
                    {PERIODS.map((p) => (
                        <button
                            key={p.key}
                            className={`${styles.timeChip}${period === p.key ? ` ${styles.active}` : ''}`}
                            onClick={() => onPeriodChange(p.key)}
                        >
                            {p.label}
                        </button>
                    ))}
                </div>

                <div className={styles.timeDivider} />

                {period === 'week' ? (
                    <WeekChips weekStart={weekStart} onChange={onWeekChange} />
                ) : (
                    <DatePicker period={period} date={date} onChange={onDateChange} />
                )}
            </div>

            <span className={styles.listHint}>{hint}</span>
        </div>
    );
}