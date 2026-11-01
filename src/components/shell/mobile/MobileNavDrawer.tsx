import {useTranslation} from 'react-i18next';
import {useLocation, useNavigate} from 'react-router';
import {IconClose} from '../../ui/icon';
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
 *
 * 关闭的路有三条（缺一都不好使）：点遮罩、右上角 ✕、选中一项。
 * **点遮罩的 onClick 挂在根 `<div>` 上**，不依赖那块透明 `<button>` 的命中区——
 * 真机上「铺满屏幕且不涂色的 button」既看不见也不收点击（GOTCHAS §55）。
 */
export function MobileNavDrawer({open, onClose}: MobileNavDrawerProps) {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const active = activeNavKey(location.pathname);

    if (!open) return null;

    return (
        <div
            className={styles.drawerRoot}
            role="dialog"
            aria-modal="true"
            aria-label={t('mobile.menu')}
            onClick={onClose}
        >
            <button type="button" className={styles.drawerScrim} aria-label={t('common.cancel')} onClick={onClose}/>
            {/* 面板自己吃掉点击：否则点面板空白处会被当成「点遮罩」而关掉抽屉 */}
            <nav className={styles.drawer} onClick={(event) => event.stopPropagation()}>
                <div className={styles.drawerHeader}>
                    <span className={styles.brand}>{t('app.title')}</span>
                    <button
                        type="button"
                        className={styles.drawerClose}
                        aria-label={t('mobile.close')}
                        onClick={onClose}
                    >
                        <IconClose size={16}/>
                    </button>
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
