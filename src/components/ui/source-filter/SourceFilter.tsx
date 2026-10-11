import {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {useActions, usePluginState, useSelect} from '../../../store';
import {IconChevronDown} from '../icon';
import {useClickOutside} from '../../../hooks/useClickOutside';
import {useState, useRef} from 'react';
import styles from './SourceFilter.module.css';

export interface SourceFilterProps {
    className?: string;
}

/**
 * 页面音源筛选。
 *
 * 两种样式（在「设置 → 音源与音质」里切换）：
 * - `tabs`：横向标签，参考哔哩哔哩频道栏，适合音源较少的场景；
 * - `drawer`：按钮 + 下拉列表，适合音源较多、需要显示更多信息的场景。
 *
 * 选中值写入 `ui.sourceFilter`：
 * - 聚合展示（aggregate）下表示「参与聚合的音源」（all = 全部）；
 * - 分源展示（perSource）下必须选中某一个音源（all 会自动收敛到第一个可用源）。
 */
export function SourceFilter({className}: SourceFilterProps) {
    const {t} = useTranslation();
    const style = useSelect((s) => s.ui.sourceFilterStyle);
    const display = useSelect((s) => s.ui.sourceDisplay);
    const value = useSelect((s) => s.ui.sourceFilter);
    const pluginList = usePluginState().list;
    const {setSourceFilter} = useActions().ui;

    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    useClickOutside(rootRef, () => setOpen(false), open);

    /* 音源清单以 **store 的插件列表**为准：桌面端来自核心（`plugin.list`），
       浏览器预览来自内置模拟源——只有这一个列表，不再与 mock 注册表各说各话 */
    const sources = useMemo(
        () =>
            pluginList
                .filter((plugin) => plugin.enabled)
                .map((plugin) => ({id: plugin.id, name: plugin.name, enabled: plugin.enabled})),
        [pluginList],
    );

    /* 分源模式必须锁定一个音源；当前选中项失效时回落到「全部」 */
    const effectiveValue = useMemo(() => {
        if (display === 'perSource' && value === 'all') return sources[0]?.id ?? 'all';
        if (value !== 'all' && !sources.some((source) => source.id === value)) return 'all';
        return value;
    }, [display, value, sources]);

    if (sources.length < 2) return null;

    const options = [
        ...(display === 'aggregate' ? [{id: 'all', name: t('source.all'), enabled: true}] : []),
        ...sources.map((source) => ({id: source.id, name: source.name, enabled: source.enabled})),
    ];

    const select = (id: string) => {
        setSourceFilter(id);
        setOpen(false);
    };

    if (style === 'tabs') {
        return (
            <div className={[styles.tabs, className].filter(Boolean).join(' ')} role="tablist">
                {options.map((option) => (
                    <button
                        key={option.id}
                        type="button"
                        role="tab"
                        aria-selected={effectiveValue === option.id}
                        className={`${styles.tab}${effectiveValue === option.id ? ` ${styles.tabActive}` : ''}`}
                        onClick={() => select(option.id)}
                    >
                        {option.name}
                    </button>
                ))}
            </div>
        );
    }

    const current = options.find((option) => option.id === effectiveValue) ?? options[0];

    return (
        <div className={[styles.drawer, className].filter(Boolean).join(' ')} ref={rootRef}>
            <button
                type="button"
                className={styles.trigger}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen((prev) => !prev)}
            >
                <span className={styles.triggerLabel}>{t('source.label')}</span>
                <span className={styles.triggerValue}>{current?.name}</span>
                <IconChevronDown size={14} className={open ? styles.chevOpen : undefined}/>
            </button>

            {open && (
                <div className={styles.menu} role="listbox" aria-label={t('source.label')}>
                    {options.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            role="option"
                            aria-selected={effectiveValue === option.id}
                            className={`${styles.menuItem}${
                                effectiveValue === option.id ? ` ${styles.menuItemActive}` : ''
                            }`}
                            onClick={() => select(option.id)}
                        >
                            {option.name}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export default SourceFilter;
