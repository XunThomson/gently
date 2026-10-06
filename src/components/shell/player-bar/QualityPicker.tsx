import {useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useClickOutside} from '../../../hooks/useClickOutside';
import {useActions, useSelect} from '../../../store';
import type {TrackQuality} from '../../../types';
import {QUALITIES_DESC, qualityLabelKey} from '../../../utils/quality';
import {IconChevronDown} from '../../ui/icon';
import styles from './Picker.module.css';

/**
 * 音质选择器（播放条内）。
 *
 * 显示的是**当前实际在播的档位**（可能因音源能力而降级）；
 * 菜单里列出全部档位，并把当前音源不支持的档位标为不可用。
 */
export function QualityPicker() {
    const {t} = useTranslation();
    const quality = useSelect((s) => s.player.quality);
    const candidates = useSelect((s) => s.player.candidates);
    const activeSource = useSelect((s) => s.player.activeSource);
    const preferredQuality = useSelect((s) => s.ui.preferredQuality);
    const {setPreferredQuality} = useActions().ui;

    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    useClickOutside(rootRef, () => setOpen(false), open);

    if (candidates.length === 0 && !quality) return null;

    /* 当前音源（或候选并集）支持的档位 */
    const supported = new Set<TrackQuality>(
        candidates
            .filter((candidate) => !activeSource || candidate.source === activeSource)
            .flatMap((candidate) => candidate.qualities),
    );

    const label = quality ? t(qualityLabelKey(quality)) : t(qualityLabelKey(preferredQuality));

    return (
        <div className={styles.picker} ref={rootRef}>
            <button
                type="button"
                className={styles.trigger}
                aria-haspopup="listbox"
                aria-expanded={open}
                title={t('quality.label')}
                onClick={() => setOpen((prev) => !prev)}
            >
                <span className={styles.triggerValue}>{label}</span>
                <IconChevronDown size={13}/>
            </button>

            {open && (
                <div className={styles.menu} role="listbox" aria-label={t('quality.label')}>
                    <p className={styles.menuHead}>{t('quality.label')}</p>

                    {QUALITIES_DESC.map((value) => {
                        const available = supported.size === 0 || supported.has(value);
                        const active = (quality ?? preferredQuality) === value;

                        return (
                            <button
                                key={value}
                                type="button"
                                role="option"
                                aria-selected={active}
                                disabled={!available}
                                className={`${styles.item}${active ? ` ${styles.itemActive}` : ''}`}
                                onClick={() => {
                                    setPreferredQuality(value);
                                    setOpen(false);
                                }}
                            >
                                <span className={styles.itemName}>{t(qualityLabelKey(value))}</span>
                                {!available && (
                                    <span className={styles.itemBadge}>{t('source.unavailable')}</span>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export default QualityPicker;
