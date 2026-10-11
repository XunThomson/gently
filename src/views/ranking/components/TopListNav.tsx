import {useTranslation} from 'react-i18next';
import type {TopListGroup} from '../../../api';
import styles from './TopListNav.module.css';

export interface TopListNavProps {
    groups: TopListGroup[];
    selectedId: string | null;
    onSelect: (itemId: string) => void;
}

/**
 * 榜单/分类树。
 *
 * 结构完全由源决定（`catalog.topLists` 返回 `{title, items}`），因此这里只做渲染：
 * 一组一行（组名 + 该组的条目），**不假设**「日/周/月」或固定榜单枚举——
 * 有的源只有一组「排行榜」，有的源按语种/风格分好几组。
 */
export function TopListNav({groups, selectedId, onSelect}: TopListNavProps) {
    const {t} = useTranslation();

    return (
        <nav className={styles.root} aria-label={t('page.ranking.title')}>
            {groups.map((group) => (
                <div key={group.title} className={styles.group}>
                    <span className={styles.groupTitle}>{group.title}</span>
                    <div className={styles.items}>
                        {group.items.map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                title={item.description}
                                aria-pressed={item.id === selectedId}
                                className={[styles.item, item.id === selectedId ? styles.active : '']
                                    .filter(Boolean)
                                    .join(' ')}
                                onClick={() => onSelect(item.id)}
                            >
                                {item.title}
                            </button>
                        ))}
                    </div>
                </div>
            ))}
        </nav>
    );
}

export default TopListNav;
