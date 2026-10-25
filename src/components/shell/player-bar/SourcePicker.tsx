import {memo, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useClickOutside} from '../../../hooks/useClickOutside';
import {catalogService} from '../../../services';
import {useActions, usePluginState, useSelect} from '../../../store';
import {IconChevronDown} from '../../ui/icon';
import styles from './Picker.module.css';

/**
 * 音源选择器（播放条内）。
 *
 * - 展示当前实际在播的音源；
 * - 自动回退时提示「当前音源不可用，已自动切换」，失败的音源在列表中标记不可用；
 * - 可手动切换到某个候选音源（只试该源）。
 */
export const SourcePicker = memo(function SourcePicker() {
    const {t} = useTranslation();
    const candidates = useSelect((s) => s.player.candidates);
    const activeSource = useSelect((s) => s.player.activeSource);
    const failedSources = useSelect((s) => s.player.failedSources);
    const resolving = useSelect((s) => s.player.resolving);
    const pluginList = usePluginState().list;
    const {switchSource, reloadSource} = useActions().player;
    const {setPreferredSource} = useActions().ui;

    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    useClickOutside(rootRef, () => setOpen(false), open);

    const nameOf = useMemo(() => {
        const map = new Map<string, string>();
        pluginList.forEach((plugin) => map.set(plugin.id, plugin.name));
        catalogService.listSources().forEach((source) => map.set(source.id, source.name));
        return (id: string) => map.get(id) ?? id;
    }, [pluginList]);

    if (candidates.length === 0 && !activeSource) return null;

    const label = resolving && !activeSource
        ? t('source.resolving')
        : activeSource
            ? nameOf(activeSource)
            : t('source.none');

    return (
        <div className={styles.picker} ref={rootRef}>
            <button
                type="button"
                className={styles.trigger}
                aria-haspopup="listbox"
                aria-expanded={open}
                title={t('source.label')}
                onClick={() => setOpen((prev) => !prev)}
            >
                <span className={styles.triggerIcon} aria-hidden="true">源</span>
                <span className={styles.triggerValue}>{label}</span>
                <IconChevronDown size={13}/>
            </button>

            {open && (
                <div className={styles.menu} role="listbox" aria-label={t('source.label')}>
                    <p className={styles.menuHead}>{t('source.label')}</p>

                    {resolving && <p className={styles.hint}>{t('source.resolving')}</p>}
                    {!resolving && failedSources.length > 0 && activeSource && (
                        <p className={styles.hint}>{t('source.fallback')}</p>
                    )}
                    {!resolving && !activeSource && <p className={styles.hint}>{t('source.none')}</p>}

                    <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        className={styles.item}
                        onClick={() => {
                            setPreferredSource(null);
                            reloadSource();
                            setOpen(false);
                        }}
                    >
                        {t('source.auto')}
                    </button>

                    {candidates.map((candidate) => {
                        const failed = failedSources.includes(candidate.source);
                        const active = activeSource === candidate.source;

                        return (
                            <button
                                key={candidate.source}
                                type="button"
                                role="option"
                                aria-selected={active}
                                title={t('source.switchTo', {name: nameOf(candidate.source)})}
                                className={`${styles.item}${active ? ` ${styles.itemActive}` : ''}`}
                                onClick={() => {
                                    switchSource(candidate.source);
                                    setOpen(false);
                                }}
                            >
                                <span className={styles.itemName}>{nameOf(candidate.source)}</span>
                                {failed && (
                                    <span className={styles.itemBadge}>{t('source.unavailable')}</span>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
});

export default SourcePicker;
