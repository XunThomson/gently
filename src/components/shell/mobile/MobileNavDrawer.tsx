import type {CSSProperties} from 'react';
import {useTranslation} from 'react-i18next';
import {useLocation, useNavigate} from 'react-router';
import {useBackToClose} from '../../../hooks/useBackToClose';
import styles from './MobileShell.module.css';
import {activeNavKey, mobileNavItems} from './nav';

export interface MobileNavDrawerProps {
    open: boolean;
    /** 跟手拖动时的偏移量（null 表示未在拖动） */
    dragOffset: number | null;
    /** 抽屉宽度（用于计算透明度等） */
    drawerWidth: number;
    onClose: () => void;
}

/**
 * 左侧导航抽屉（手机上的「侧边栏」）。
 *
 * 为什么是抽屉而不是底部 tab：手机竖屏要优先把宽度留给列表，
 * 底部只留常驻播放条；导航项有 8 个，塞进 tab 也放不下。
 *
 * 数据来源只有 `nav.tsx` 一处：加页面/改顺序都在那里，抽屉与 home 判定自动跟上。
 *
 * **跟手交互**（R138）：
 * - 抽屉始终挂载（不再 `if (!open) return null`），以便实时响应拖动
 * - `dragOffset` 控制抽屉的 translateX：拖动时实时跟随手指
 * - 松手后由父组件决定最终状态（打开/关闭），CSS transition 接管动画
 * - 遮罩透明度也随拖动进度变化
 *
 * 关闭的路有三条（缺一都不好使）：点遮罩、选中一项、安卓系统返回。
 */
export function MobileNavDrawer({open, dragOffset, drawerWidth, onClose}: MobileNavDrawerProps) {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const active = activeNavKey(location.pathname);
    const handledHistory = useBackToClose(open, onClose);

    /* 计算抽屉的 translateX：
       - 未在拖动（dragOffset === null）：按 open 状态决定 0 或 -drawerWidth
       - 拖动中：使用 dragOffset（范围 -drawerWidth ~ 0） */
    const translateX = dragOffset !== null ? dragOffset : (open ? 0 : -drawerWidth);

    /* 遮罩透明度：按抽屉露出比例计算 */
    const scrimOpacity = dragOffset !== null
        ? (drawerWidth + dragOffset) / drawerWidth
        : (open ? 1 : 0);

    /* 是否在拖动：拖动时禁用 transition，松手后启用 */
    const isDragging = dragOffset !== null;

    /* 面板的上下内边距 = 常规间距 + 状态栏让位（由 shell 的 --mobile-safe-top 统一提供，
       不再各算一遍 app.config 的近似值） */
    const panelStyle = {
        paddingTop: 'calc(var(--space-3) + var(--mobile-safe-top, 0px))',
        transform: `translateX(${translateX}px)`,
        transition: isDragging ? 'none' : `transform var(--motion-base)`,
    } as CSSProperties;

    const scrimStyle = {
        opacity: scrimOpacity,
        transition: isDragging ? 'none' : `opacity var(--motion-fast)`,
        /* 遮罩完全透明时不拦截点击 */
        pointerEvents: scrimOpacity > 0 ? 'auto' as const : 'none' as const,
    } as CSSProperties;

    /* 抽屉关闭且未在拖动时不渲染内容（节省 DOM），但仍保留容器以支持动画 */
    const shouldRender = open || dragOffset !== null;

    if (!shouldRender) return null;

    return (
        <div
            className={styles.drawerRoot}
            role="dialog"
            aria-modal="true"
            aria-label={t('mobile.menu')}
            aria-hidden={!open && !isDragging}
            onClick={onClose}
        >
            <button
                type="button"
                className={styles.drawerScrim}
                style={scrimStyle}
                data-drawer-scrim=""
                aria-label={t('common.cancel')}
                onClick={onClose}
            />
            <nav
                className={styles.drawer}
                style={panelStyle}
                data-drawer-panel=""
                onClick={(event) => event.stopPropagation()}
            >
                <div className={styles.drawerHeader}>
                    <span className={styles.brand}>{t('app.title')}</span>
                </div>
                {mobileNavItems.map((item) => {
                    const isActive = active === item.key;
                    return (
                        <button
                            key={item.key}
                            type="button"
                            className={isActive ? styles.drawerItemActive : styles.drawerItem}
                            aria-current={isActive ? 'page' : undefined}
                            onClick={() => {
                                const hasMarker =
                                    (history.state as {gentlyOverlay?: boolean} | null)?.gentlyOverlay ===
                                    true;
                                handledHistory();
                                onClose();
                                navigate(item.path, {replace: hasMarker});
                            }}
                        >
                            <span className={styles.drawerItemIcon}>{item.icon}</span>
                            <span className={styles.drawerItemLabel}>{t(item.labelKey)}</span>
                        </button>
                    );
                })}
            </nav>
        </div>
    );
}

export default MobileNavDrawer;
