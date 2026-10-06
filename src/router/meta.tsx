import type {AppRoute, MenuRoute} from './routes.types'
import {IconClock, IconDownload, IconFire, IconFolder, IconGear, IconPuzzle, IconTrophy} from '../components/ui/icon'

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
 * 菜单顺序 / 文案 / 图标统一由 meta 派生，保证路由与导航单一数据源。
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
    {
        path: 'setting',
        lazy: () => import('../views/setting'),
        meta: {labelKey: 'nav.setting', icon: <IconGear/>, order: 7},
    },
]
