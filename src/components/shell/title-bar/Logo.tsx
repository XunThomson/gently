import styles from './title-bar.module.css';

/**
 * 应用标识。
 * 文案与字号/颜色均来自主题 token（theme.config.json → components.titleBar）。
 *
 * `compact` 只保留图形标：紧凑模式下标题栏的横向空间要优先让给搜索框。
 */
export function Logo({compact = false}: {compact?: boolean}) {
    return (
        <div className={styles.logo}>
            <span className={styles.logoMark}>G</span>
            {!compact && <span className={styles.logoText}>Gently</span>}
        </div>
    );
}

export default Logo;
