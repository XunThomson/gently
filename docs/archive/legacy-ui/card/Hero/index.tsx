import styles from './Hero.module.css';

interface Props {
    onPlay: () => void;
}

export default function Hero({ onPlay }: Props) {
    return (
        <section className={styles.hero}>
            <div className={styles.heroCover}>
                <div className={styles.disc} />
            </div>

            <div className={styles.heroInfo}>
        <span className={styles.heroTag}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l2.6 6.5 7 .5-5.4 4.5 1.7 6.8L12 16.7 6.1 20.3l1.7-6.8L2.4 9l7-.5z" />
          </svg>
          今日推荐
        </span>

                <h1>晚风告白</h1>
                <p className={styles.sub}>林清野 · 《晚风告白》</p>

                <div className={styles.heroMeta}>
                    <span>流行 · 国语</span>
                    <i />
                    <span>发行于 2025-09-18</span>
                    <i />
                    <span>热度 98%</span>
                </div>

                <button className={styles.btnPlay} onClick={onPlay}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M7 4.5v15l13-7.5z" />
                    </svg>
                    立即播放
                </button>
            </div>
        </section>
    );
}