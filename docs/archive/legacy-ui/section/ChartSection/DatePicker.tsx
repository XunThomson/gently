import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './DatePicker.module.css';
import { daysInMonth, pad2 } from '../../../utils/helpers';
import type { DateSelection, Period } from '../../../types';

type ColKey = 'year' | 'month' | 'day';

interface Column {
    key: ColKey;
    items: number[];
    current: number;
}

interface Props {
    period: Period; // 'day' | 'month' | 'year'
    date: DateSelection;
    onChange: (next: DateSelection) => void;
}

export default function DatePicker({ period, date, onChange }: Props) {
    const { year, month, day } = date;

    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const colsRef = useRef<HTMLDivElement>(null);

    /* ---------- 候选列 ---------- */
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

        const list: Column[] = [{ key: 'year', items: years, current: year }];
        if (period !== 'year') list.push({ key: 'month', items: months, current: month });
        if (period === 'day') list.push({ key: 'day', items: days, current: day });
        return list;
    }, [period, year, month, day]);

    /* ---------- 点击外部 / ESC 关闭 ---------- */
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

    /* ---------- 当前项滚到中间 ---------- */
    useEffect(() => {
        if (!open || !colsRef.current) return;

        const raf = requestAnimationFrame(() => {
            colsRef.current?.querySelectorAll<HTMLElement>(`.${styles.col}`).forEach((col) => {
                const active = col.querySelector<HTMLElement>(`.${styles.item}.${styles.active}`);
                active?.scrollIntoView({ block: 'center' });
            });
        });

        return () => cancelAnimationFrame(raf);
    }, [open, cols]);

    /* ---------- 选择 ---------- */
    const handlePick = (key: ColKey, value: number) => {
        const now = new Date();
        const curY = now.getFullYear();
        const curM = now.getMonth() + 1;
        const curD = now.getDate();

        const next: DateSelection = { ...date };

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
            next.year === curY && next.month === curM
                ? curD
                : daysInMonth(next.year, next.month);
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
                className={`${styles.trigger}${open ? ` ${styles.open}` : ''}`}
                onClick={() => setOpen((v) => !v)}
            >
                <svg className={styles.calIcon} width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <rect
                        x="3"
                        y="5"
                        width="18"
                        height="16"
                        rx="2"
                        stroke="currentColor"
                        strokeWidth="1.8"
                    />
                    <path
                        d="M3 10h18M8 3v4M16 3v4"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                    />
                </svg>
                <span>{label}</span>
                <svg className={styles.chev} width="11" height="11" viewBox="0 0 24 24" fill="none">
                    <path
                        d="M6 9l6 6 6-6"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </svg>
            </button>

            {open && (
                <div className={styles.panel}>
                    <div className={styles.cols} ref={colsRef}>
                        {cols.map((col) => (
                            <div className={styles.col} key={col.key}>
                                {col.items.map((v) => (
                                    <button
                                        key={v}
                                        className={`${styles.item}${
                                            v === col.current ? ` ${styles.active}` : ''
                                        }`}
                                        onClick={() => handlePick(col.key, v)}
                                    >
                                        {col.key === 'year' ? v : pad2(v)}
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