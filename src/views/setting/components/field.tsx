import type {ReactNode} from 'react';
import styles from '../setting.module.css';

export interface FieldProps {
    label: ReactNode;
    /** 该行的补充说明：统一跟在行下方，样式与组内其它 hint 一致 */
    hint?: ReactNode;
    children: ReactNode;
}

/**
 * 统一设置行：左标签 + 右控件（窄屏由 CSS 自动改成上下排）。
 * 说明文字必须是 hint，不再散落成独立段落。
 */
export function Field({label, hint, children}: FieldProps) {
    return (
        <>
            <div className={styles.field}>
                <span className={styles.label}>{label}</span>
                <div className={styles.value}>{children}</div>
            </div>
            {hint && <p className={styles.hint}>{hint}</p>}
        </>
    );
}

export default Field;
