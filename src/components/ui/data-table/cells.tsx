import type {ReactNode} from 'react';
import styles from './cells.module.css';

/**
 * 表格单元格渲染器：把常见的单元格形态收敛成组件，
 * 列定义（config）只负责组合，不重复写样式。
 */

type Tone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'danger';

export function TextCell({children, tone = 'default'}: { children: ReactNode; tone?: Tone }) {
    return <span className={styles[tone]}>{children}</span>;
}

export function BadgeCell({children, tone = 'default'}: { children: ReactNode; tone?: Tone }) {
    return <span className={`${styles.badge} ${styles[`badge_${tone}`]}`}>{children}</span>;
}

/** 进度单元格：进度条 + 文案（下载进度、热度等） */
export function ProgressCell({value, label}: { value: number; label: string }) {
    const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
    return (
        <div className={styles.progress}>
            <div className={styles.progressBar}>
                <i style={{width: `${percent}%`}}/>
            </div>
            <span className={styles.progressLabel}>{label}</span>
        </div>
    );
}

export interface RowAction {
    key: string;
    label: string;
    onClick: () => void;
    tone?: 'default' | 'primary' | 'danger';
    disabled?: boolean;
}

export function ActionsCell({actions}: { actions: RowAction[] }) {
    return (
        <div className={styles.actions}>
            {actions.map((action) => (
                <button
                    key={action.key}
                    type="button"
                    disabled={action.disabled}
                    className={`${styles.action} ${styles[`action_${action.tone ?? 'default'}`]}`}
                    onClick={(e) => {
                        e.stopPropagation();
                        action.onClick();
                    }}
                >
                    {action.label}
                </button>
            ))}
        </div>
    );
}
