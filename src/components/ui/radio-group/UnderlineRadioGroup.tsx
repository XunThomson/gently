import {useState} from 'react';
import styles from './UnderlineRadioGroup.module.css';

export interface RadioOption<T extends string | number> {
    label: string;
    value: T;
}

export interface UnderlineRadioGroupProps<T extends string | number> {
    name: string;
    options: (T | RadioOption<T>)[];
    value?: T;
    defaultValue?: T;
    onChange?: (value: T) => void;
    className?: string;
}

function isRadioOption<T extends string | number>(
    option: T | RadioOption<T>,
): option is RadioOption<T> {
    return typeof option === 'object' && option !== null && 'value' in option && 'label' in option;
}

/**
 * 下划线式单选组：受控 / 非受控皆可。
 * 样式全部走主题 token（不使用 tailwind，因为该组件的视觉需要被主题动态控制）。
 */
export function UnderlineRadioGroup<T extends string | number>({
    name,
    options,
    value,
    defaultValue,
    onChange,
    className,
}: UnderlineRadioGroupProps<T>) {
    const [internalValue, setInternalValue] = useState<T | undefined>(defaultValue);
    const isControlled = value !== undefined;
    const currentValue = isControlled ? value : internalValue;

    const handleChange = (optionValue: T) => {
        if (!isControlled) setInternalValue(optionValue);
        onChange?.(optionValue);
    };

    return (
        <div className={[styles.root, className].filter(Boolean).join(' ')}>
            {options.map((option) => {
                const optionValue = isRadioOption(option) ? option.value : option;
                const optionLabel = isRadioOption(option) ? option.label : String(option);
                const key = String(optionValue);

                return (
                    <label key={key} className={styles.item}>
                        <input
                            type="radio"
                            name={name}
                            value={key}
                            checked={currentValue === optionValue}
                            onChange={() => handleChange(optionValue)}
                            className={styles.input}
                        />
                        <span className={styles.label}>{optionLabel}</span>
                    </label>
                );
            })}
        </div>
    );
}

UnderlineRadioGroup.displayName = 'UnderlineRadioGroup';

export default UnderlineRadioGroup;
