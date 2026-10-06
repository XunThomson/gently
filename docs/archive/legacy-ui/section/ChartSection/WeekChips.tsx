import { useMemo } from 'react';
import styles from './WeekChips.module.css';
import { pad2 } from '../../../utils/helpers';
import type { DateSelection, WeekOption } from '../../../types';

interface Props {
    weekStart: DateSelection;
    onChange: (weekStart: DateSelection) => void;
}

export default function WeekChips({ weekStart, onChange }: Props) {
    const weeks = useMemo<WeekOption[]>(() => {
        const now = new Date();
        const dow = now.getDay() || 7;
        const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow + 1);

        const out: WeekOption[] = [];
        for (let i = 0; i < 8; i++) {
            const start = new Date(thisMonday.getTime() - i * 7 * 86400000);
            const end = new Date(start.getTime() + 6 * 86400000);
            out.push({
                year: start.getFullYear(),
                month: start.getMonth() + 1,
                day: start.getDate(),
                label: `${pad2(start.getMonth() + 1)}/${pad2(start.getDate())}`,
                range: `${pad2(start.getMonth() + 1)}/${pad2(start.getDate())} – ${pad2(
                    end.getMonth() + 1,
                )}/${pad2(end.getDate())}`,
                isCurrent: i === 0,
            });
        }
        return out;
    }, []);

    const isActive = (w: WeekOption) =>
        w.year === weekStart.year && w.month === weekStart.month && w.day === weekStart.day;

    return (
        <div className={styles.chips}>
            {weeks.map((w) => (
                <button
                    key={`${w.year}-${w.month}-${w.day}`}
                    className={`${styles.chip}${isActive(w) ? ` ${styles.active}` : ''}`}
                    title={w.range}
                    onClick={() => onChange({ year: w.year, month: w.month, day: w.day })}
                >
                    {w.label}
                    {w.isCurrent && <span className={styles.curTag}>本周</span>}
                </button>
            ))}
        </div>
    );
}