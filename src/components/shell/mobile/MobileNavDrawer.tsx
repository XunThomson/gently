import {useTranslation} from 'react-i18next';
import {useLocation, useNavigate} from 'react-router';
import styles from './MobileShell.module.css';
import {activeNavKey, mobileNavItems} from './nav';

export interface MobileNavDrawerProps {
    open: boolean;
    onClose: () => void;
}

/**
 * 左侧导航抽屉（手机上的「侧边栏」）。
 *
 * 为什么是抽屉而不是底部 tab：手机竖屏要优先把宽度留给列表，
 * 底部只留常驻播放条；导航项有 8 个，塞进 tab 也放不下。
 *
 * 数据来源只有 `nav.tsx` 一处：加页面/改顺序都在那里，抽屉与 home 判定自动跟上。
 */
export function MobileNavDrawer({open, onClose}: MobileNavDrawerProps) {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const active = activeNavKey(location.pathname);

    if (!open) return null;

    return (
        <div className={styles.drawerRoot} role="dialog" aria-modal="true" aria-label={t('mobile.menu')}>
            <button type="button" className={styles.drawerScrim} aria-label={t('common.cancel')} onClick={onClose}/>
            <nav className={styles.drawer}>
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
                                onClose();
                                navigate(item.path);
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
