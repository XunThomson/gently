import {NavLink} from 'react-router';
import {useTranslation} from 'react-i18next';
import {useActions, useSelect} from '../../../store';
import type {MenuRoute} from '../../../router/routes.types';
import {IconChevronDown, IconChevronRight, IconMusic} from '../../ui/icon';
import styles from './Sidebar.module.css';

export interface SidebarProps {
    /** 主菜单（由路由 meta 派生，保证菜单与路由单一数据源） */
    mainMenu: MenuRoute[];
    /** 我的歌单 */
    playlists?: MenuRoute[];
    /** 我的收藏 */
    favorites?: MenuRoute[];
}

/**
 * 侧边导航。
 * - 选中态由 URL 决定（react-router NavLink），不再维护重复的 activeKey 状态；
 * - 分组折叠状态集中在 store 的 ui.collapsedGroups。
 */
export function Sidebar({mainMenu, playlists = [], favorites = []}: SidebarProps) {
    const {t} = useTranslation();
    const {toggleGroup} = useActions().ui;
    const collapsedGroups = useSelect((s) => s.ui.collapsedGroups);

    const renderItem = (item: MenuRoute) => (
        <li key={item.key}>
            <NavLink
                to={item.path}
                className={({isActive}) =>
                    [styles.item, isActive ? styles.itemActive : ''].filter(Boolean).join(' ')
                }
            >
                {item.icon && <span className={styles.itemIcon}>{item.icon}</span>}
                <span className={styles.itemLabel}>{t(item.labelKey)}</span>
            </NavLink>
        </li>
    );

    const renderGroup = (key: string, titleKey: string, items: MenuRoute[]) => {
        const collapsed = collapsedGroups.includes(key);

        return (
            <div className={styles.group} key={key}>
                <button
                    type="button"
                    className={styles.groupTitle}
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroup(key)}
                >
                    <span>{t(titleKey)}</span>
                    {collapsed ? <IconChevronRight size={14}/> : <IconChevronDown size={14}/>}
                </button>

                {!collapsed &&
                    (items.length > 0 ? (
                        <ul className={styles.menu}>{items.map(renderItem)}</ul>
                    ) : (
                        <p className={styles.empty}>
                            <IconMusic size={14}/>
                            {t('sidebar.noPlaylists')}
                        </p>
                    ))}
            </div>
        );
    };

    return (
        <nav className={styles.sidebar}>
            <ul className={styles.menu}>{mainMenu.map(renderItem)}</ul>

            {renderGroup('playlists', 'sidebar.playlists', playlists)}
            {renderGroup('favorites', 'sidebar.favorites', favorites)}
        </nav>
    );
}

export default Sidebar;
