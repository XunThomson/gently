import type {ReactNode} from 'react';
import styles from '../setting.module.css';

export interface SectionProps {
    /** 锚点 id：左侧导航点击后滚到这里 */
    id: string;
    title: string;
    /** 组的一句话说明（组内设置的共同前提，不重复单个设置项的 hint） */
    description: string;
    children: ReactNode;
}

/**
 * 设置分组：一个语义组 = 一层卡片（组标题 + 一句话说明 + 组内条目）。
 *
 * 组内的设置项一律是「行」；子块（背景 / 壁纸助手 / 缓存 / 诊断）只用
 * `subTitle` + 分隔线，不再套第二层卡片。
 */
export function Section({id, title, description, children}: SectionProps) {
    const titleId = `${id}-title`;
    return (
        <section id={id} className={styles.section} aria-labelledby={titleId}>
            <header className={styles.sectionHeader}>
                <h2 id={titleId} className={styles.sectionTitle}>
                    {title}
                </h2>
                <p className={styles.sectionDesc}>{description}</p>
            </header>
            <div className={styles.sectionBody}>{children}</div>
        </section>
    );
}

export default Section;
