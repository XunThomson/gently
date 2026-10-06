import type { ComponentType, ReactNode } from 'react'

export interface RouteMeta {
    /** i18n 文案 key */
    labelKey?: string
    icon?: ReactNode
    /** 是否在菜单中隐藏 */
    hideInMenu?: boolean
    /** 菜单排序，越小越靠前（默认 999） */
    order?: number
    /** 所需权限 */
    permission?: string
}

export interface AppRoute {
    path?: string
    lazy?: () => Promise<{ default: ComponentType }>
    meta?: RouteMeta
    children?: AppRoute[]
    index?: boolean
    element?: ReactNode
}

/** 由 AppRoute 派生的菜单项 */
export interface MenuRoute {
    key: string
    path: string
    labelKey: string
    icon?: ReactNode
    order: number
}