import type {ButtonHTMLAttributes, ReactNode} from 'react';
import styles from './Button.module.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'default' | 'ghost' | 'danger';
    size?: 'sm' | 'md';
    icon?: ReactNode;
}

/** 通用按钮：视觉由主题 token 驱动，避免各视图重复写按钮样式。 */
export function Button({
    variant = 'default',
    size = 'md',
    icon,
    children,
    className,
    type = 'button',
    ...rest
}: ButtonProps) {
    return (
        <button
            type={type}
            className={[styles.button, styles[variant], styles[size], className]
                .filter(Boolean)
                .join(' ')}
            {...rest}
        >
            {icon}
            {children}
        </button>
    );
}

export default Button;
