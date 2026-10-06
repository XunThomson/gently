import styles from './title-bar.module.css';

/**
 * 应用标识。
 * 文案与字号/颜色均来自主题 token（theme.config.json → components.titleBar）。
 */
export function Logo() {
    return (
        <div className={styles.logo}>
            <span className={styles.logoMark}>G</span>
            <span className={styles.logoText}>Gently</span>
        </div>
    );
}

export default Logo;
