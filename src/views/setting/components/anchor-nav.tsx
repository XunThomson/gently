import {useEffect, useMemo, useRef, useState} from 'react';
import styles from '../setting.module.css';

export interface AnchorItem {
    /** 对应 `Section` 的 id */
    id: string;
    label: string;
}

export interface AnchorNavProps {
    items: AnchorItem[];
    /** nav 的无障碍名称（一个页面里可能不止一组导航） */
    label: string;
}

/**
 * 设置分组锚点导航。
 *
 * 桌面：左侧竖排 sticky，点击滚到对应分组，滚动时高亮当前组；
 * 窄窗口：由 CSS 退化成吸顶的横向 chips（同一份 DOM，不额外分支）。
 *
 * 「当前组」用 IntersectionObserver 判定而不是监听 scroll：真正的滚动容器是
 * 外壳的 main 区域（`overflow: auto`），scroll 事件不冒泡，监听 window 收不到。
 */
export function AnchorNav({items, label}: AnchorNavProps) {
    const activeId = useActiveSection(items);

    /* 低动画：减少动效偏好下不做平滑滚动 */
    const reducedMotion = useMemo(
        () =>
            typeof window !== 'undefined' &&
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        [],
    );

    const jump = (id: string) => {
        document.getElementById(id)?.scrollIntoView({
            behavior: reducedMotion ? 'auto' : 'smooth',
            block: 'start',
        });
    };

    return (
        <nav className={styles.nav} aria-label={label}>
            {items.map((item) => {
                const active = item.id === activeId;
                return (
                    <button
                        key={item.id}
                        type="button"
                        className={`${styles.navItem} ${active ? styles.navItemActive : ''}`}
                        aria-current={active ? 'true' : undefined}
                        onClick={() => jump(item.id)}
                    >
                        {item.label}
                    </button>
                );
            })}
        </nav>
    );
}

/** 当前视口里的第一个分组：观察不到时保持上一次的选中项 */
function useActiveSection(items: AnchorItem[]): string {
    const firstId = items[0]?.id ?? '';
    const [activeId, setActiveId] = useState(firstId);
    const visible = useRef(new Map<string, boolean>());

    useEffect(() => {
        if (typeof IntersectionObserver === 'undefined') return;
        const nodes = items
            .map((item) => document.getElementById(item.id))
            .filter((node): node is HTMLElement => node !== null);
        if (nodes.length === 0) return;

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    visible.current.set(entry.target.id, entry.isIntersecting);
                }
                const current = items.find((item) => visible.current.get(item.id));
                if (current) setActiveId(current.id);
            },
            /* 只把「还没滚出屏幕上方 55%」的组算作当前组，滚到底时最后一组也能追上 */
            {rootMargin: '0px 0px -55% 0px'},
        );
        for (const node of nodes) observer.observe(node);
        return () => observer.disconnect();
    }, [items]);

    return activeId;
}

export default AnchorNav;
