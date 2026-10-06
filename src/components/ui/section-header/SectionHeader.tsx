import type {ReactNode} from 'react';
import styles from './SectionHeader.module.css';

export interface SectionHeaderProps {
    title: string;
    subtitle?: string;
    /** 右侧额外内容（如筛选、操作按钮） */
    extra?: ReactNode;
}

/** 区块标题：左侧标题 + 副标题，右侧插槽。 */
export function SectionHeader({title, subtitle, extra}: SectionHeaderProps) {
    return (
        <div className={styles.root}>
            <h2 className={styles.title}>
                {title}
                {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
            </h2>
            {extra}
        </div>
    );
}

export default SectionHeader;
