import {useEffect, useMemo, useRef, useState} from 'react';
import {IconCalendar, IconChevronDown} from '../../../components/ui/icon';
import {daysInMonth, pad2} from '../../../utils/date';
import type {DateSelection, Period} from '../../../types';
import styles from './DatePicker.module.css';

type ColKey = 'year' | 'month' | 'day';

interface Column {
    key: ColKey;
    items: number[];
    current: number;
}

export interface DatePickerProps {
    /** day / month / year */
    period: Period;
    date: DateSelection;
    onChange: (next: DateSelection) => void;
}

/** 榜单时间选择器：滚轮式年 / 月 / 日三列。 */
export function DatePicker({period, date, onChange}: DatePickerProps) {
    const {year, month, day} = date;

    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const colsRef = useRef<HTMLDivElement>(null);

    const cols = useMemo<Column[]>(() => {
        const now = new Date();
        const curY = now.getFullYear();
        const curM = now.getMonth() + 1;
        const curD = now.getDate();

        const years: number[] = [];
        for (let y = curY; y >= curY - 9; y--) years.push(y);

        const maxMonth = year === curY ? curM : 12;
        const months: number[] = [];
        for (let m = 1; m <= maxMonth; m++) months.push(m);

        let maxDay = daysInMonth(year, month);
        if (year === curY && month === curM) maxDay = curD;
        const days: number[] = [];
        for (let d = 1; d <= maxDay; d++) days.push(d);

        const list: Column[] = [{key: 'year', items: years, current: year}];
        if (period !== 'year') list.push({key: 'month', items: months, current: month});
        if (period === 'day') list.push({key: 'day', items: days, current: day});
        return list;
    }, [period, year, month, day]);

    /* 点击外部 / ESC 关闭 */
    useEffect(() => {
        if (!open) return;

        const onDocClick = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };

        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('click', onDocClick);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    /* 当前项滚到中间 */
    useEffect(() => {
        if (!open || !colsRef.current) return;

        const raf = requestAnimationFrame(() => {
            colsRef.current?.querySelectorAll<HTMLElement>(`.${styles.col}`).forEach((col) => {
                col.querySelector<HTMLElement>(`.${styles.item}.${styles.active}`)?.scrollIntoView({block: 'center'});
            });
        });

        return () => cancelAnimationFrame(raf);
    }, [open, cols]);

    const handlePick = (key: ColKey, value: number) => {
        const now = new Date();
        const curY = now.getFullYear();
        const curM = now.getMonth() + 1;
        const curD = now.getDate();

        const next: DateSelection = {...date};

        if (key === 'year') {
            next.year = value;
            const maxMonth = value === curY ? curM : 12;
            next.month = Math.min(next.month, maxMonth);
        } else if (key === 'month') {
            next.month = value;
        } else {
            next.day = value;
        }

        const maxDay =
            next.year === curY && next.month === curM ? curD : daysInMonth(next.year, next.month);
        next.day = Math.min(next.day, maxDay);

        onChange(next);
    };

    const label =
        period === 'day'
            ? `${year}-${pad2(month)}-${pad2(day)}`
            : period === 'month'
                ? `${year}-${pad2(month)}`
                : `${year}`;

    return (
        <div className={styles.wrap} ref={wrapRef}>
            <button
                type="button"
                className={`${styles.trigger}${open ? ` ${styles.open}` : ''}`}
                onClick={() => setOpen((v) => !v)}
            >
                <IconCalendar size={14} className={styles.calIcon}/>
                <span>{label}</span>
                <IconChevronDown size={11} className={styles.chev}/>
            </button>

            {open && (
                <div className={styles.panel}>
                    <div className={styles.cols} ref={colsRef}>
                        {cols.map((col) => (
                            <div className={styles.col} key={col.key}>
                                {col.items.map((value) => (
                                    <button
                                        key={value}
                                        type="button"
                                        className={`${styles.item}${
                                            value === col.current ? ` ${styles.active}` : ''
                                        }`}
                                        onClick={() => handlePick(col.key, value)}
                                    >
                                        {col.key === 'year' ? value : pad2(value)}
                                    </button>
                                ))}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

export default DatePicker;
