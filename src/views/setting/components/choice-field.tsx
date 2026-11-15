import {useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {UnderlineRadioGroup} from '../../../components/ui/radio-group';
import {IconChevronRight} from '../../../components/ui/icon';
import {useBackToClose} from '../../../hooks/useBackToClose';
import {useSwipeDownClose} from '../../../hooks/useSwipeDownClose';
import {isMobilePlatform} from '../../../utils/platform';
import {Field} from './field';
import settings from '../setting.module.css';
import styles from './choice-sheet.module.css';

export interface ChoiceFieldOption {
    value: string;
    label: string;
}

export interface ChoiceFieldProps {
    label: string;
    hint?: string;
    options: readonly ChoiceFieldOption[];
    value: string;
    onChange: (value: string) => void;
}

/**
 * 设置里的单选行（R144 移动适配）。
 *
 * 桌面：沿用行内下划线单选（一屏能看见全部选项）。
 * 手机：**一行 = 标签 + 当前值 + 箭头**，点开底部选择面板——这是安卓设置的标准形态；
 * 把 4 个长选项硬塞进行尾只会把标签挤成两行。
 */
export function ChoiceField({label, hint, options, value, onChange}: ChoiceFieldProps) {
    const mobile = isMobilePlatform();
    const [open, setOpen] = useState(false);
    const sheetRef = useRef<HTMLDivElement | null>(null);
    useBackToClose(open, () => setOpen(false));
    const {dragY, dragging, bind} = useSwipeDownClose(() => setOpen(false), 80, sheetRef, open);
    const current = options.find((option) => option.value === value)?.label ?? value;

    if (!mobile) {
        return (
            <Field label={label} hint={hint}>
                <UnderlineRadioGroup
                    name={`choice-${label}`}
                    value={value}
                    options={options.map((option) => ({value: option.value, label: option.label}))}
                    onChange={onChange}
                />
            </Field>
        );
    }

    return (
        <>
            <button
                type="button"
                className={settings.row}
                aria-haspopup="dialog"
                onClick={() => setOpen(true)}
            >
                <span className={settings.rowText}>
                    <span className={settings.rowLabel}>{label}</span>
                    {hint && <span className={settings.rowHint}>{hint}</span>}
                </span>
                <span className={settings.rowValue}>{current}</span>
                <IconChevronRight size={16}/>
            </button>

            {open &&
                typeof document !== 'undefined' &&
                createPortal(
                    <div className={styles.scrim} onClick={() => setOpen(false)}>
                        <div
                            className={styles.sheet}
                            ref={sheetRef}
                            role="dialog"
                            aria-modal="true"
                            aria-label={label}
                            data-dragging={dragging}
                            style={dragY > 0 ? {transform: `translateY(${dragY}px)`} : undefined}
                            onClick={(event) => event.stopPropagation()}
                        >
                            <div className={styles.grabber} aria-hidden="true" {...bind}>
                                <div className={styles.grabberBar}/>
                            </div>
                            <div className={styles.head} {...bind}>
                                <span className={styles.title}>{label}</span>
                            </div>
                            <div className={styles.options} role="radiogroup" aria-label={label}>
                                {options.map((option) => {
                                    const active = option.value === value;
                                    return (
                                        <button
                                            key={option.value}
                                            type="button"
                                            role="radio"
                                            aria-checked={active}
                                            className={styles.option}
                                            data-active={active}
                                            onClick={() => {
                                                onChange(option.value);
                                                setOpen(false);
                                            }}
                                        >
                                            <span className={styles.optionLabel}>{option.label}</span>
                                            <span className={styles.mark} aria-hidden="true"/>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>,
                    document.body,
                )}
        </>
    );
}

export default ChoiceField;
