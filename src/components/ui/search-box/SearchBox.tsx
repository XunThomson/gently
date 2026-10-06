/* ==================== SearchBox.tsx ==================== */
import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import styles from './search-box.module.css';

import type {Group, SearchBoxProps} from './types';
import {cx, highlight} from './utils';
import {
    IconClock as ClockIcon,
    IconClose as CloseIcon,
    IconSearch as SearchIcon,
} from '../icon';
import {useControllableValue} from './hooks/useControllableValue';
import {useClickOutside} from './hooks/useClickOutside';
import {useSearchHistory} from './hooks/useSearchHistory';
import {useSuggestions} from './hooks/useSuggestions';

const SearchBox: React.FC<SearchBoxProps> = ({
                                                 value: valueProp,
                                                 defaultValue = '',
                                                 placeholder,
                                                 suggestions,
                                                 hotWords = [],
                                                 historyKey = 'sb:history',
                                                 maxHistory = 10,
                                                 openMode = 'focus',
                                                 debounce = 250,
                                                 autoFocus = false,
                                                 submitText,
                                                 className,
                                                 onSearch,
                                                 onChange,
                                                 onOpenChange,
                                             }) => {
    const { t } = useTranslation();

    const [value, setValue] = useControllableValue(valueProp, defaultValue, onChange);
    const keyword = value.trim();

    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);

    const rootRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const openRef = useRef(false);
    const uid = useRef(`sb-${Math.random().toString(36).slice(2, 9)}`).current;
    const listId = `${uid}-listbox`;

    const {history, add: addHistory, remove: removeHistory, clear: clearHistory} =
        useSearchHistory(historyKey, maxHistory);

    const {list: suggestionList, loading} = useSuggestions(keyword, suggestions, debounce);

    /* ---------- 面板开关（统一入口，同步回调） ---------- */
    const changeOpen = useCallback(
        (next: boolean) => {
            if (openRef.current === next) return;
            openRef.current = next;
            setOpen(next);
            onOpenChange?.(next);
        },
        [onOpenChange]
    );

    /* ---------- 构建分组 ---------- */
    const groups = useMemo<Group[]>(() => {
        const gs: Group[] = [];
        let offset = 0;

        if (keyword) {
            if (suggestionList.length) {
                gs.push({
                    key: 'suggestion',
                    title: t('search.suggestion'),
                    items: suggestionList,
                    offset: 0,
                });
                offset += suggestionList.length;
            }
        } else {
            if (history.length) {
                gs.push({
                    key: 'history',
                    title: t('search.history'),
                    items: history.map((v) => ({value: v})),
                    offset: 0,
                });
                offset += history.length;
            }
            if (hotWords.length) {
                gs.push({
                    key: 'hot',
                    title: t('search.hot'),
                    items: hotWords.map((v) => ({value: v})),
                    offset,
                });
            }
        }
        return gs;
    }, [keyword, suggestionList, history, hotWords, t]);

    const options = useMemo(() => groups.flatMap((g) => g.items), [groups]);

    /* ---------- 索引校正 & 滚动可见 ---------- */
    useEffect(() => {
        setActiveIndex((i) => (i >= options.length ? -1 : i));
    }, [options.length]);

    useEffect(() => {
        if (!open || activeIndex < 0) return;
        panelRef.current
            ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
            ?.scrollIntoView({block: 'nearest'});
    }, [activeIndex, open]);

    /* ---------- 点击外部关闭 ---------- */
    const handleOutside = useCallback(() => {
        changeOpen(false);
        setActiveIndex(-1);
    }, [changeOpen]);

    useClickOutside(rootRef, handleOutside, open);

    /* ---------- 提交搜索 ---------- */
    const commit = useCallback(
        (raw: string) => {
            const kw = raw.trim();
            if (!kw) return;

            setValue(kw);
            if (historyKey) addHistory(kw);

            changeOpen(false);
            setActiveIndex(-1);
            onSearch?.(kw);
        },
        [setValue, historyKey, addHistory, changeOpen, onSearch]
    );

    /* ---------- 输入 / 聚焦 / 清空 ---------- */
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const next = e.target.value;
        setValue(next);
        setActiveIndex(-1);

        if (openMode === 'input' && !next.trim()) changeOpen(false);
        else changeOpen(true);
    };

    const handleFocus = () => {
        if (openMode === 'input' && !keyword) return;
        changeOpen(true);
    };

    const handleClear = () => {
        setValue('');
        setActiveIndex(-1);
        inputRef.current?.focus();
        if (openMode === 'input') changeOpen(false);
    };

    /* ---------- 键盘导航 ---------- */
    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        switch (e.key) {
            case 'ArrowDown': {
                e.preventDefault();
                if (!openRef.current) {
                    changeOpen(true);
                    return;
                }
                if (!options.length) return;
                setActiveIndex((i) => (i + 1) % options.length);
                break;
            }
            case 'ArrowUp': {
                e.preventDefault();
                if (!options.length) return;
                setActiveIndex((i) => (i - 1 + options.length) % options.length);
                break;
            }
            case 'Enter': {
                e.preventDefault();
                const opt = options[activeIndex];
                commit(opt ? opt.value : value);
                break;
            }
            case 'Escape': {
                if (openRef.current) {
                    e.preventDefault();
                    changeOpen(false);
                    setActiveIndex(-1);
                }
                break;
            }
            case 'Tab': {
                changeOpen(false);
                break;
            }
            default:
                break;
        }
    };

    /* ---------- 历史记录操作 ---------- */
    const handleClearHistory = () => {
        clearHistory();
        setActiveIndex(-1);
        inputRef.current?.focus();
    };

    const handleRemoveHistory = (kw: string) => {
        removeHistory(kw);
        setActiveIndex(-1);
    };

    /* ---------- 面板可见性 ---------- */
    const showEmpty =
        !!keyword && !loading && suggestionList.length === 0 && !!suggestions;
    const hasContent = loading || groups.length > 0 || showEmpty;
    const panelVisible = open && hasContent;

    return (
        <div
            ref={rootRef}
            className={cx(styles.sbRoot, panelVisible && styles.isOpen, className)}
        >
            {/* ============ 输入区 ============ */}
            <div className={styles.sbField}>
        <span className={styles.sbFieldIcon} aria-hidden="true">
          <SearchIcon/>
        </span>

                <input
                    ref={inputRef}
                    className={styles.sbInput}
                    type="text"
                    value={value}
                    placeholder={placeholder ?? t('search.placeholder')}
                    autoFocus={autoFocus}
                    autoComplete="off"
                    spellCheck={false}
                    role="combobox"
                    aria-expanded={panelVisible}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-haspopup="listbox"
                    aria-activedescendant={
                        panelVisible && activeIndex >= 0
                            ? `${uid}-opt-${activeIndex}`
                            : undefined
                    }
                    onChange={handleChange}
                    onFocus={handleFocus}
                    onKeyDown={handleKeyDown}
                />

                {value && (
                    <button
                        type="button"
                        className={styles.sbClear}
                        aria-label={t('search.clearInput')}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={handleClear}
                    >
                        <CloseIcon/>
                    </button>
                )}

                <button
                    type="button"
                    className={styles.sbSubmit}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commit(value)}
                >
                    {submitText ?? t('search.submit')}
                </button>
            </div>

            {/* ============ 面板 / 移动端抽屉 ============ */}
            {panelVisible && (
                <>
                    <div className={styles.sbMask} onClick={() => changeOpen(false)}/>

                    <div
                        ref={panelRef}
                        id={listId}
                        className={styles.sbPanel}
                        role="listbox"
                        aria-label={t('search.suggestion')}
                    >
                        {loading && (
                            <div className={styles.sbStatus}>
                                <span className={styles.sbSpinner} aria-hidden="true"/>
                                {t('search.searching')}
                            </div>
                        )}

                        {groups.map((group) => (
                            <div
                                className={styles.sbGroup}
                                key={group.key}
                                role="group"
                                aria-label={group.title}
                            >
                                <div className={styles.sbGroupHead}>
                                    <span className={styles.sbGroupTitle}>{group.title}</span>
                                    {group.key === 'history' && (
                                        <button
                                            type="button"
                                            className={styles.sbGroupAction}
                                            onMouseDown={(e) => e.preventDefault()}
                                            onClick={handleClearHistory}
                                        >
                                            {t('search.clearHistory')}
                                        </button>
                                    )}
                                </div>

                                {/* —— 热门搜索：标签云 —— */}
                                {group.key === 'hot' ? (
                                    <div className={styles.sbTags} role="presentation">
                                        {group.items.map((item, i) => {
                                            const gi = group.offset + i;
                                            return (
                                                <button
                                                    key={item.value}
                                                    type="button"
                                                    role="option"
                                                    aria-selected={activeIndex === gi}
                                                    id={`${uid}-opt-${gi}`}
                                                    data-index={gi}
                                                    className={cx(
                                                        styles.sbTag,
                                                        activeIndex === gi && styles.isActive
                                                    )}
                                                    onPointerEnter={() => setActiveIndex(gi)}
                                                    onMouseDown={(e) => e.preventDefault()}
                                                    onClick={() => commit(item.value)}
                                                >
                                                    {item.value}
                                                </button>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    /* —— 联想 / 历史：列表行 —— */
                                    group.items.map((item, i) => {
                                        const gi = group.offset + i;
                                        const isActive = activeIndex === gi;
                                        return (
                                            <div
                                                key={`${item.value}-${gi}`}
                                                id={`${uid}-opt-${gi}`}
                                                role="option"
                                                aria-selected={isActive}
                                                data-index={gi}
                                                className={cx(
                                                    styles.sbOption,
                                                    isActive && styles.isActive
                                                )}
                                                onPointerEnter={() => setActiveIndex(gi)}
                                                onMouseDown={(e) => e.preventDefault()}
                                                onClick={() => commit(item.value)}
                                            >
                                                {group.key === 'history' && (
                                                    <span className={styles.sbOptionIcon} aria-hidden="true">
                            <ClockIcon size={15}/>
                          </span>
                                                )}

                                                <span className={styles.sbOptionLabel}>
                          {group.key === 'suggestion'
                              ? highlight(item.label ?? item.value, keyword, styles.sbHl)
                              : item.value}
                        </span>

                                                {item.desc && (
                                                    <span className={styles.sbOptionDesc}>{item.desc}</span>
                                                )}

                                                {group.key === 'history' && (
                                                    <button
                                                        type="button"
                                                        className={styles.sbOptionDel}
                                                        tabIndex={-1}
                                                        aria-label={t('search.deleteHistory', {value: item.value})}
                                                        onMouseDown={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                        }}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleRemoveHistory(item.value);
                                                        }}
                                                    >
                                                        <CloseIcon/>
                                                    </button>
                                                )}
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        ))}

                        {showEmpty && (
                            <div className={styles.sbEmpty}>
                                {t('search.noResult', {keyword})}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

export default SearchBox;
