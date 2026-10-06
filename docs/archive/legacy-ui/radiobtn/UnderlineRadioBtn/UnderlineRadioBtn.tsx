import { useState } from 'react';
import styles from './UnderlineRadioBtn.module.css';

export type RadioOption<T extends string | number> = {
    label: string;
    value: T;
};

export interface UnderlineRadioBtnProps<T extends string | number> {
    name: string;
    options: (T | RadioOption<T>)[];
    value?: T;
    defaultValue?: T;
    onChange?: (value: T) => void;
    className?: string;
}

function isRadioOption<T extends string | number>(
    option: T | RadioOption<T>
): option is RadioOption<T> {
    return (
        typeof option === 'object' &&
        option !== null &&
        'value' in option &&
        'label' in option
    );
}

export function UnderlineRadioBtn<T extends string | number>({
                                                                 name,
                                                                 options,
                                                                 value,
                                                                 defaultValue,
                                                                 onChange,
                                                                 className = '',
                                                             }: UnderlineRadioBtnProps<T>) {
    const [internalValue, setInternalValue] = useState<T | undefined>(defaultValue);
    const isControlled = value !== undefined;
    const currentValue = isControlled ? value : internalValue;

    const handleChange = (optionValue: T) => {
        if (!isControlled) setInternalValue(optionValue);
        onChange?.(optionValue);
    };

    return (
        <div
            className={`tw:flex tw:mt-3 tw:mr-8 tw:space-x-3 tw:select-none ${className}`}
        >
            {options.map((option) => {
                const optionValue = isRadioOption(option) ? option.value : option;
                const optionLabel = isRadioOption(option) ? option.label : String(option);
                const key = String(optionValue);

                return (
                    <label
                        key={key}
                        className="tw:flex tw:items-center tw:justify-center tw:flex-grow tw:cursor-pointer"
                    >
                        {/* 隐藏原生 radio，peer 作为状态标记保留 */}
                        <input
                            type="radio"
                            name={name}
                            value={key}
                            checked={currentValue === optionValue}
                            onChange={() => handleChange(optionValue)}
                            className={`tw:hidden peer ${styles.input}`}
                        />
                        {/* 动画完全交由 CSS Module */}
                        <span className={styles.span}>{optionLabel}</span>
                    </label>
                );
            })}
        </div>
    );
}

UnderlineRadioBtn.displayName = 'UnderlineRadioBtn';

export default UnderlineRadioBtn;