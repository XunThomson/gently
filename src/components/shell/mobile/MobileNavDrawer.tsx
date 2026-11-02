import type {CSSProperties} from 'react';
import {useTranslation} from 'react-i18next';
import {useLocation, useNavigate} from 'react-router';
import {appConfig} from '../../../config/app.config';
import {useBackToClose} from '../../../hooks/useBackToClose';
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
 *
 * 顶部要让出状态栏：抽屉是 `position: absolute; inset: 0` 的覆盖层，`top: 0` 落在 shell 的
 * **padding box** 上（也就是状态栏下面那 30px 让位区之内），不会自动让位——
 * 不让的话品牌行与 ✕ 会被状态栏的时钟盖住（R120 走查发现）。
 */
export function MobileNavDrawer({open, onClose}: MobileNavDrawerProps) {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();
    const active = activeNavKey(location.pathname);
    /* 安卓的系统返回 = 关抽屉（主流习惯）；抽屉里因此**不再放 ✕**：
       点旁边空白、按返回、选中一项，三条路都能关（R121 用户反馈） */
    const handledHistory = useBackToClose(open, onClose);

    if (!open) return null;

    /* 面板的上下内边距 = 常规间距 + 状态栏让位（值来自 `app.config`，不写进 CSS） */
    const panelStyle = {
        paddingTop: `calc(var(--space-3) + ${appConfig.mobile.statusBarInset}px)`,
    } as CSSProperties;

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
            <nav className={styles.drawer} style={panelStyle} onClick={(event) => event.stopPropagation()}>
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
                                /* 抽屉打开时，`useBackToClose` 在历史里压了一条**同 URL** 的标记。
                                   直接 `navigate()` 会在它上面再压一层：多出一条「按了返回没反应」的
                                   垃圾历史。用 `replace` 把这层标记换成目标路由——页换了、历史不多一条。
                                   而且要**先告诉 hook「历史我自己处理」**：它收起时若再 back 一次，
                                   会把还没落地的异步导航弹回去（R137 真机：冷启动后第一次点必失败）。 */
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
