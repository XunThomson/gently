import {useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {
    IconCalendar,
    IconChevronDown,
    IconChevronLeft,
    IconChevronRight,
} from '../../../components/ui/icon';
import {daysInMonth, pad2, today} from '../../../utils/date';
import type {DateSelection, Period} from '../../../types';
import styles from './DatePicker.module.css';

/** 年 / 月选择器与年榜展示的年份数量：最近 12 年（含今年） */
const YEAR_SPAN = 12;

export interface DatePickerProps {
    /** day / month / year；week 由调用方直接展示，不进入本组件 */
    period: Period;
    date: DateSelection;
    onChange: (next: DateSelection) => void;
}

/** 是否晚于今天（今天本身不算未来） */
const isAfterToday = (year: number, month: number, day: number): boolean => {
    const now = today();
    if (year !== now.year) return year > now.year;
    if (month !== now.month) return month > now.month;
    return day > now.day;
};

/** 最近 12 年，由新到旧 */
const lastYears = (): number[] => {
    const {year} = today();
    return Array.from({length: YEAR_SPAN}, (_, i) => year - i);
};

/**
 * 榜单时间选择器：日 = 月历；月 / 年 = 胶囊网格。
 * 未来日期一律不可选；年份只在需要时展开，触发按钮只显示最短标签。
 */
export function DatePicker({period, date, onChange}: DatePickerProps) {
    const {t, i18n} = useTranslation();

    const [open, setOpen] = useState(false);
    const [monthSelect, setMonthSelect] = useState(false);
    const [view, setView] = useState({year: date.year, month: date.month});

    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);

    const {year, month, day} = date;
    const now = useMemo(today, []);
    const years = useMemo(lastYears, []);
    const minYear = years[years.length - 1];
    const maxIndex = now.year * 12 + now.month - 1;

    /* Intl 文案跟随应用语言（月名 / 星期 / 标题） */
    const intl = useMemo(
        () => ({
            title: new Intl.DateTimeFormat(i18n.language, {month: 'long'}),
            monthShort: new Intl.DateTimeFormat(i18n.language, {month: 'short'}),
            weekday: new Intl.DateTimeFormat(i18n.language, {weekday: 'narrow'}),
        }),
        [i18n.language],
    );

    /* 星期表头：以周一为第一列，顺序与月历一致 */
    const weekdays = useMemo(() => {
        /* 2024-01-01 是周一 */
        return Array.from({length: 7}, (_, i) =>
            intl.weekday.format(new Date(2024, 0, 1 + i)),
        );
    }, [intl]);

    /* 点击外部 / ESC 关闭 */
    useEffect(() => {
        if (!open) return;

        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            setOpen(false);
            /* 焦点落在面板里时归还给触发器，避免焦点丢失到 body */
            if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
        };

        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    const openPanel = (expand: boolean) => {
        setView({year, month});
        setMonthSelect(expand);
        setOpen(true);
    };

    /** 输出完整且合法的选择：日夹到当月天数，且不晚于今天 */
    const emit = (yearValue: number, monthValue: number, dayValue: number) => {
        const inCurrentMonth = yearValue === now.year && monthValue === now.month;
        const ceil = inCurrentMonth ? Math.min(daysInMonth(yearValue, monthValue), now.day) : daysInMonth(yearValue, monthValue);
        onChange({year: yearValue, month: monthValue, day: Math.min(dayValue, ceil)});
    };

    /** 日 / 月视图翻月，且不越过当月 */
    const shiftMonth = (delta: number) => {
        const index = Math.min(view.year * 12 + view.month - 1 + delta, maxIndex);
        setView({year: Math.floor(index / 12), month: (index % 12) + 1});
    };

    const shiftYear = (delta: number) => {
        setView((prev) => ({
            ...prev,
            year: Math.min(Math.max(prev.year + delta, minYear), now.year),
        }));
    };

    const canNextMonth = view.year * 12 + view.month <= maxIndex;

    /* ---------- 月历（day） ---------- */

    const dayGrid = () => {
        const total = daysInMonth(view.year, view.month);
        /* 周一为第一列 */
        const lead = (new Date(view.year, view.month - 1, 1).getDay() + 6) % 7;
        const cells: Array<number | null> = [
            ...Array.from({length: lead}, () => null),
            ...Array.from({length: total}, (_, i) => i + 1),
        ];

        return (
            <div className={styles.grid}>
                {weekdays.map((name, i) => (
                    <span className={styles.dow} key={`${name}-${i}`}>
                        {name}
                    </span>
                ))}

                {cells.map((value, i) => {
                    if (value === null) return <span className={styles.blank} key={`blank-${i}`}/>;

                    const selected = view.year === year && view.month === month && value === day;
                    const isToday = view.year === now.year && view.month === now.month && value === now.day;

                    return (
                        <button
                            key={value}
                            type="button"
                            className={[
                                styles.day,
                                selected ? styles.daySelected : '',
                                isToday ? styles.dayToday : '',
                            ]
                                .filter(Boolean)
                                .join(' ')}
                            aria-pressed={selected}
                            aria-current={isToday ? 'date' : undefined}
                            disabled={isAfterToday(view.year, view.month, value)}
                            onClick={() => {
                                setView({year, month});
                                onChange({year, month, day: value});
                            }}
                        >
                            {value}
                        </button>
                    );
                })}
            </div>
        );
    };

    /* ---------- 面板主体 ---------- */

    const monthChips = (forYear: number, onPick: (value: number) => void) => (
        <div className={styles.months}>
            {Array.from({length: 12}, (_, i) => i + 1).map((value) => {
                const selected = forYear === year && value === month;
                return (
                    <button
                        key={value}
                        type="button"
                        className={`${styles.month}${selected ? ` ${styles.monthSelected}` : ''}`}
                        aria-pressed={selected}
                        disabled={isAfterToday(forYear, value, 1)}
                        onClick={() => onPick(value)}
                    >
                        {intl.monthShort.format(new Date(forYear, value - 1, 1))}
                    </button>
                );
            })}
        </div>
    );

    /** 年步进器：跨年可用，但不喧宾夺主 */
    const yearStepper = (yearValue: number, onShift: (delta: number) => void) => (
        <div className={styles.nav}>
            <button
                type="button"
                className={styles.navBtn}
                aria-label={String(yearValue - 1)}
                disabled={yearValue <= minYear}
                onClick={() => onShift(-1)}
            >
                <IconChevronLeft size={13}/>
            </button>
            <span className={styles.title}>{yearValue}</span>
            <button
                type="button"
                className={styles.navBtn}
                aria-label={String(yearValue + 1)}
                disabled={yearValue >= now.year}
                onClick={() => onShift(1)}
            >
                <IconChevronRight size={13}/>
            </button>
        </div>
    );

    const body = () => {
        if (period === 'year') {
            return (
                <div className={styles.years}>
                    {years.map((value) => (
                        <button
                            key={value}
                            type="button"
                            className={`${styles.month}${value === year ? ` ${styles.monthSelected}` : ''}`}
                            aria-pressed={value === year}
                            onClick={() => {
                                emit(value, month, day);
                                setOpen(false);
                            }}
                        >
                            {value}
                        </button>
                    ))}
                </div>
            );
        }

        if (period === 'month') {
            return (
                <>
                    {yearStepper(view.year, shiftYear)}
                    {monthChips(view.year, (value) => {
                        emit(view.year, value, day);
                        setOpen(false);
                    })}
                </>
            );
        }

        /* 展开态：年步进器 + 12 个月胶囊 */
        if (monthSelect) {
            return (
                <>
                    {yearStepper(view.year, shiftYear)}
                    {monthChips(view.year, (value) => {
                        setView({year: view.year, month: value});
                        setMonthSelect(false);
                    })}
                </>
            );
        }

        return (
            <>
                <div className={styles.nav}>
                    <button
                        type="button"
                        className={styles.navBtn}
                        aria-label={`${view.year}-${pad2(view.month === 1 ? 12 : view.month - 1)}`}
                        onClick={() => shiftMonth(-1)}
                    >
                        <IconChevronLeft size={13}/>
                    </button>
                    <button
                        type="button"
                        className={styles.titleBtn}
                        aria-expanded={monthSelect}
                        onClick={() => setMonthSelect(true)}
                    >
                        <span className={styles.title}>
                            {intl.title.format(new Date(view.year, view.month - 1, 1))}
                        </span>
                        <IconChevronDown size={12} className={styles.titleChev}/>
                    </button>
                    <button
                        type="button"
                        className={styles.navBtn}
                        aria-label={`${view.year}-${pad2(view.month === 12 ? 1 : view.month + 1)}`}
                        disabled={!canNextMonth}
                        onClick={() => shiftMonth(1)}
                    >
                        <IconChevronRight size={13}/>
                    </button>
                </div>
                {dayGrid()}
            </>
        );
    };

    /* 触发按钮：只在必要时出现年份 */
    const label =
        period === 'day'
            ? year === now.year && month === now.month && day === now.day
                ? t('page.ranking.today')
                : `${pad2(month)}-${pad2(day)}`
            : period === 'month'
                ? `${year}-${pad2(month)}`
                : `${year}`;

    /* 周榜由调用方用 WeekChips 渲染，这里只做防御性兜底 */
    if (period === 'week') return null;

    return (
        <div className={styles.wrap} ref={rootRef}>
            <button
                ref={triggerRef}
                type="button"
                className={`${styles.trigger}${open ? ` ${styles.open}` : ''}`}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => (open ? setOpen(false) : openPanel(false))}
            >
                <IconCalendar size={14} className={styles.calIcon}/>
                <span>{label}</span>
                <IconChevronDown size={11} className={styles.chev}/>
            </button>

            {open && (
                <div className={styles.panel} role="dialog" aria-label={label}>
                    {body()}
                </div>
            )}
        </div>
    );
}

export default DatePicker;
