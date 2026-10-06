import {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {pad2} from '../../../utils/date';
import type {DateSelection, WeekOption} from '../../../types';
import styles from './WeekChips.module.css';

const WEEK_COUNT = 8;

export interface WeekChipsProps {
    weekStart: DateSelection;
    onChange: (weekStart: DateSelection) => void;
}

/** 周榜的最近若干周快捷选择。 */
export function WeekChips({weekStart, onChange}: WeekChipsProps) {
    const {t} = useTranslation();

    const weeks = useMemo<WeekOption[]>(() => {
        const now = new Date();
        const dow = now.getDay() || 7;
        const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + 1);

        return Array.from({length: WEEK_COUNT}, (_, i) => {
            const start = new Date(monday.getTime() - i * 7 * 86400000);
            const end = new Date(start.getTime() + 6 * 86400000);
            return {
                year: start.getFullYear(),
                month: start.getMonth() + 1,
                day: start.getDate(),
                label: `${pad2(start.getMonth() + 1)}/${pad2(start.getDate())}`,
                range: `${pad2(start.getMonth() + 1)}/${pad2(start.getDate())} – ${pad2(
                    end.getMonth() + 1,
                )}/${pad2(end.getDate())}`,
                isCurrent: i === 0,
            };
        });
    }, []);

    const isActive = (week: WeekOption) =>
        week.year === weekStart.year && week.month === weekStart.month && week.day === weekStart.day;

    return (
        <div className={styles.chips}>
            {weeks.map((week) => (
                <button
                    key={`${week.year}-${week.month}-${week.day}`}
                    type="button"
                    className={`${styles.chip}${isActive(week) ? ` ${styles.active}` : ''}`}
                    title={week.range}
                    onClick={() => onChange({year: week.year, month: week.month, day: week.day})}
                >
                    {week.label}
                    {week.isCurrent && <span className={styles.tag}>{t('page.ranking.thisWeek')}</span>}
                </button>
            ))}
        </div>
    );
}

export default WeekChips;
