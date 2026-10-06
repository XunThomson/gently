import styles from './ChartTabs.module.css';
import type { ChartType } from '../../../types';

const TABS: { key: ChartType; label: string }[] = [
    { key: 'hot', label: '热歌榜' },
    { key: 'new', label: '新歌榜' },
    { key: 'rise', label: '飙升榜' },
    { key: 'origin', label: '原创榜' },
];

interface Props {
    value: ChartType;
    onChange: (chart: ChartType) => void;
}

export default function ChartTabs({ value, onChange }: Props) {
    return (
        <div className={styles.tabs}>
            {TABS.map((tab) => (
                <button
                    key={tab.key}
                    className={`${styles.tab}${value === tab.key ? ` ${styles.active}` : ''}`}
                    onClick={() => onChange(tab.key)}
                >
                    {tab.label}
                </button>
            ))}
        </div>
    );
}