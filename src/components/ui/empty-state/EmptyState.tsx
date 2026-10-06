import type {ReactNode} from 'react';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
    icon?: ReactNode;
    title: string;
    hint?: string;
    className?: string;
}

/** 统一空态：替换各视图中重复的空列表提示。 */
export function EmptyState({icon, title, hint, className}: EmptyStateProps) {
    return (
        <div className={[styles.root, className].filter(Boolean).join(' ')}>
            {icon && <div className={styles.icon}>{icon}</div>}
            <p className={styles.title}>{title}</p>
            {hint && <p className={styles.hint}>{hint}</p>}
        </div>
    );
}

export default EmptyState;
