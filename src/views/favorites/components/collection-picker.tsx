import {useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {IconChevronDown, IconSearch} from '../../../components/ui/icon';
import {useClickOutside} from '../../../hooks/useClickOutside';
import styles from '../favorites.module.css';

/** 一次最多渲染多少条：收藏夹可能上千个，全渲染会让下拉卡住（用搜索缩小范围更实际） */
const MAX_RENDER = 200;

export interface CollectionOption {
    id: string;
    title: string;
    count?: number;
}

interface Props {
    options: CollectionOption[];
    /** 当前选中的收藏夹 id */
    value: string;
    onChange: (id: string) => void;
}

/**
 * 收藏夹选择器：触发器 + 可搜索的下拉抽屉。
 *
 * 为什么不是一排单选：用户报的场景很具体——「不一定需要全部收藏夹，可能是部分内容，
 * 一次性展示过于暴力，如果说存在上千个收藏夹呢？」。所以：
 * - 收起时只占一个按钮（显示当前收藏夹与数量）；
 * - 展开后有搜索框，按名字过滤；
 * - 超过 [`MAX_RENDER`] 条只渲染前一批，并**说清还有多少**（继续输入就能缩小）。
 */
export function CollectionPicker({options, value, onChange}: Props) {
    const {t} = useTranslation();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const rootRef = useRef<HTMLDivElement>(null);

    useClickOutside(rootRef, () => setOpen(false), open);

    const current = options.find((option) => option.id === value) ?? options[0];

    const filtered = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        if (!keyword) return options;
        return options.filter((option) => option.title.toLowerCase().includes(keyword));
    }, [options, query]);

    const shown = filtered.slice(0, MAX_RENDER);

    const labelOf = (option: CollectionOption) =>
        option.count === undefined ? option.title : `${option.title}（${option.count}）`;

    return (
        <div className={styles.picker} ref={rootRef}>
            <button
                type="button"
                className={styles.pickerTrigger}
                aria-expanded={open}
                onClick={() => setOpen((prev) => !prev)}
            >
                <span className={styles.pickerValue}>{current ? labelOf(current) : t('page.favorites.collectionPicker')}</span>
                <span className={styles.pickerCount}>
                    {t('page.favorites.collectionTotal', {count: options.length})}
                </span>
                <IconChevronDown size={13}/>
            </button>

            {open && (
                <div className={styles.pickerPanel} role="dialog" aria-label={t('page.favorites.collectionPicker')}>
                    <label className={styles.pickerSearch}>
                        <IconSearch size={13}/>
                        <input
                            type="search"
                            value={query}
                            placeholder={t('page.favorites.collectionSearch')}
                            aria-label={t('page.favorites.collectionSearch')}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </label>

                    <p className={styles.pickerStat}>
                        {query.trim()
                            ? t('page.favorites.collectionMatch', {count: filtered.length})
                            : t('page.favorites.collectionTotal', {count: options.length})}
                    </p>

                    <ul className={styles.pickerList}>
                        {shown.map((option) => (
                            <li key={option.id}>
                                <button
                                    type="button"
                                    className={styles.pickerItem}
                                    data-active={option.id === current?.id}
                                    onClick={() => {
                                        onChange(option.id);
                                        setOpen(false);
                                    }}
                                >
                                    {labelOf(option)}
                                </button>
                            </li>
                        ))}
                        {shown.length === 0 && (
                            <li className={styles.pickerEmpty}>{t('page.favorites.collectionNone')}</li>
                        )}
                    </ul>

                    {filtered.length > shown.length && (
                        <p className={styles.pickerStat}>
                            {t('page.favorites.collectionMore', {count: filtered.length - shown.length})}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
