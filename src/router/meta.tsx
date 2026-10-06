import type {AppRoute, MenuRoute} from './routes.types'
import {
    IconClock,
    IconDownload,
    IconFire,
    IconFolder,
    IconGear,
    IconPalette,
    IconPuzzle,
    IconTrophy,
} from '../components/ui/icon'

/**
 * 把路由树摊平成菜单列表（会自动忽略 hideInMenu / 无 labelKey 的节点）
 * 支持嵌套：父级有 children 时子项也会被收集，并拼上父级路径
 */
export function buildMenuRoutes(
    routes: AppRoute[],
    parentPath = '',
): MenuRoute[] {
    return routes
        .flatMap((r) => {
            const fullPath = r.path ? joinPath(parentPath, r.path) : parentPath
            const {labelKey, icon, hideInMenu, order} = r.meta ?? {}

            const self: MenuRoute | null =
                labelKey && !hideInMenu
                    ? {
                        key: fullPath,
                        path: fullPath,
                        labelKey,
                        icon,
                        order: order ?? 999,
                    }
                    : null

            const children = r.children ? buildMenuRoutes(r.children, fullPath) : []
            return self ? [self, ...children] : children
        })
        .sort((a, b) => a.order - b.order)
}

function joinPath(parent: string, child: string): string {
    return `/${[parent, child].filter(Boolean).join('/')}`.replace(/\/+/g, '/')
}

/**
 * 应用路由表。
 *
 * - 侧边栏主菜单 = 有 labelKey 且未 hideInMenu 的路由；
 * - 「收藏 / 歌单 / 歌曲详情」由侧边栏与播放条主动跳转，不进主菜单；
 * - 「设置」只在右上角工具栏提供入口（避免与侧边栏重复）。
 */
export const appRoutes: AppRoute[] = [
    {
        path: 'ranking',
        lazy: () => import('../views/ranking'),
        meta: {labelKey: 'nav.ranking', icon: <IconTrophy/>, order: 1},
    },
    {
        path: 'hot',
        lazy: () => import('../views/hot'),
        meta: {labelKey: 'nav.hot', icon: <IconFire/>, order: 2},
    },
    {
        path: 'download',
        lazy: () => import('../views/download'),
        meta: {labelKey: 'nav.download', icon: <IconDownload/>, order: 3},
        children: [
            // 默认展示「已下载」，直接复用子视图，避免重定向造成的 tab 闪烁
            {index: true, lazy: () => import('../views/download/downloaded')},
            {path: 'downloading', lazy: () => import('../views/download/downloading')},
            {path: 'downloaded', lazy: () => import('../views/download/downloaded')},
        ],
    },
    {
        path: 'local',
        lazy: () => import('../views/local'),
        meta: {labelKey: 'nav.local', icon: <IconFolder/>, order: 4},
    },
    {
        path: 'plugin',
        lazy: () => import('../views/plugin'),
        meta: {labelKey: 'nav.plugin', icon: <IconPuzzle/>, order: 5},
    },
    {
        path: 'recent',
        lazy: () => import('../views/recent'),
        meta: {labelKey: 'nav.recent', icon: <IconClock/>, order: 6},
    },

    /* ---------- 不在主菜单中，由外壳入口跳转 ---------- */
    {
        path: 'favorites',
        lazy: () => import('../views/favorites'),
    },
    {
        path: 'search',
        lazy: () => import('../views/search'),
    },
    {
        path: 'playlist/:id',
        lazy: () => import('../views/playlist'),
    },
    {
        path: 'now-playing',
        lazy: () => import('../views/now-playing'),
    },
    {
        path: 'theme',
        lazy: () => import('../views/theme'),
        meta: {labelKey: 'nav.theme', icon: <IconPalette/>, hideInMenu: true},
    },
    {
        path: 'setting',
        lazy: () => import('../views/setting'),
        meta: {labelKey: 'nav.setting', icon: <IconGear/>, hideInMenu: true},
    },
]
