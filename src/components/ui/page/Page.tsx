import type {ReactNode} from 'react';
import styles from './Page.module.css';

export interface PageProps {
    title: string;
    subtitle?: string;
    /** 标题右侧的操作区（筛选、按钮等） */
    toolbar?: ReactNode;
    children: ReactNode;
}

/**
 * 视图统一容器：标题 + 可选工具条 + 内容。
 * 所有页面共用一套间距 / 标题规格（由 theme.config.json 的 view 段驱动）。
 */
export function Page({title, subtitle, toolbar, children}: PageProps) {
    return (
        <section className={styles.page}>
            <header className={styles.header}>
                <div className={styles.heading}>
                    <h1 className={styles.title}>{title}</h1>
                    {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
                </div>
                {toolbar && <div className={styles.toolbar}>{toolbar}</div>}
            </header>

            <div className={styles.content}>{children}</div>
        </section>
    );
}

export default Page;
