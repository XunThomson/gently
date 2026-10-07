import {useState, type ReactNode} from 'react';
import {NavLink, useNavigate} from 'react-router';
import {useTranslation} from 'react-i18next';
import {useActions, useSelect} from '../../../store';
import {useConfirm} from '../../../hooks/useConfirm';
import type {MenuRoute} from '../../../router/routes.types';
import {IconChevronDown, IconChevronRight, IconHeart, IconMusic, IconPlus, IconTrash} from '../../ui/icon';
import styles from './Sidebar.module.css';

export interface SidebarProps {
    /** 主菜单（由路由 meta 派生，保证菜单与路由单一来源） */
    mainMenu: MenuRoute[];
}

/**
 * 侧边导航。
 * - 主菜单选中态由 URL 决定（react-router NavLink），不维护重复状态；
 * - 收藏 / 歌单来自集中式 store 的 collection 切片，支持新建、删除、查看数量；
 * - 分组折叠状态集中在 store 的 ui.collapsedGroups。
 */
export function Sidebar({mainMenu}: SidebarProps) {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const {toggleGroup} = useActions().ui;
    const {createPlaylist, removePlaylist} = useActions().collection;
    const confirm = useConfirm();
    const collapsedGroups = useSelect((s) => s.ui.collapsedGroups);
    const favorites = useSelect((s) => s.collection.favorites);
    const playlists = useSelect((s) => s.collection.playlists);

    const [creating, setCreating] = useState(false);
    const [draftName, setDraftName] = useState('');

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

    const groupHeader = (key: string, titleKey: string, action?: ReactNode) => {
        const collapsed = collapsedGroups.includes(key);
        return (
            <div className={styles.groupHead}>
                <button
                    type="button"
                    className={styles.groupTitle}
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroup(key)}
                >
                    {collapsed ? <IconChevronRight size={14}/> : <IconChevronDown size={14}/>}
                    <span>{t(titleKey)}</span>
                </button>
                {!collapsed && action}
            </div>
        );
    };

    const submitNewPlaylist = () => {
        const name = draftName.trim();
        if (!name) {
            setCreating(false);
            setDraftName('');
            return;
        }
        const playlist = createPlaylist(name);
        setDraftName('');
        setCreating(false);
        navigate(`/playlist/${playlist.id}`);
    };

    return (
        <nav className={styles.sidebar}>
            <ul className={styles.menu}>{mainMenu.map(renderItem)}</ul>

            {/* ---------- 我的收藏 ---------- */}
            <div className={styles.group}>
                {groupHeader('favorites', 'sidebar.favorites')}
                {!collapsedGroups.includes('favorites') && (
                    <ul className={styles.menu}>
                        <li>
                            <NavLink
                                to="/favorites"
                                className={({isActive}) =>
                                    [styles.item, isActive ? styles.itemActive : '']
                                        .filter(Boolean)
                                        .join(' ')
                                }
                            >
                                <span className={styles.itemIcon}>
                                    <IconHeart size={16}/>
                                </span>
                                <span className={styles.itemLabel}>{t('sidebar.favorites')}</span>
                                <span
                                    className={styles.count}
                                    title={t('sidebar.trackCount', {count: favorites.length})}
                                >
                                    {favorites.length}
                                </span>
                            </NavLink>
                        </li>
                    </ul>
                )}
            </div>

            {/* ---------- 我的歌单 ---------- */}
            <div className={styles.group}>
                {groupHeader(
                    'playlists',
                    'sidebar.playlists',
                    <button
                        type="button"
                        className={styles.groupAction}
                        title={t('sidebar.newPlaylist')}
                        aria-label={t('sidebar.newPlaylist')}
                        onClick={() => setCreating((prev) => !prev)}
                    >
                        <IconPlus size={14}/>
                    </button>,
                )}

                {!collapsedGroups.includes('playlists') && (
                    <>
                        {creating && (
                            <form
                                className={styles.createRow}
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    submitNewPlaylist();
                                }}
                            >
                                <input
                                    className={styles.createInput}
                                    autoFocus
                                    value={draftName}
                                    placeholder={t('page.playlist.namePlaceholder')}
                                    onChange={(e) => setDraftName(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Escape') {
                                            setCreating(false);
                                            setDraftName('');
                                        }
                                    }}
                                />
                                <button type="submit" className={styles.createSubmit}>
                                    {t('common.create')}
                                </button>
                            </form>
                        )}

                        {playlists.length === 0 && !creating ? (
                            <p className={styles.empty}>
                                <IconMusic size={14}/>
                                {t('sidebar.noPlaylists')}
                            </p>
                        ) : (
                            <ul className={styles.menu}>
                                {playlists.map((playlist) => (
                                    <li key={playlist.id} className={styles.playlistRow}>
                                        <NavLink
                                            to={`/playlist/${playlist.id}`}
                                            className={({isActive}) =>
                                                [styles.item, isActive ? styles.itemActive : '']
                                                    .filter(Boolean)
                                                    .join(' ')
                                            }
                                        >
                                            <span className={styles.itemIcon}>
                                                <IconMusic size={16}/>
                                            </span>
                                            <span className={styles.itemLabel}>{playlist.name}</span>
                                            <span
                                                className={styles.count}
                                                title={t('sidebar.trackCount', {
                                                    count: playlist.tracks.length,
                                                })}
                                            >
                                                {playlist.tracks.length}
                                            </span>
                                        </NavLink>
                                        <button
                                            type="button"
                                            className={styles.rowAction}
                                            title={t('page.playlist.delete')}
                                            aria-label={t('page.playlist.delete')}
                                            onClick={() =>
                                                confirm({
                                                    titleKey: 'confirm.deletePlaylistTitle',
                                                    descKey: 'confirm.deletePlaylistDesc',
                                                    descParams: {name: playlist.name},
                                                    tone: 'danger',
                                                    onConfirm: () => removePlaylist(playlist.id),
                                                })
                                            }
                                        >
                                            <IconTrash size={14}/>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </>
                )}
            </div>
        </nav>
    );
}

export default Sidebar;
