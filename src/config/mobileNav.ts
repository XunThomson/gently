/**
 * 移动端导航 / 「主页」配置的**唯一数据源**。
 *
 * 这里只放纯数据（不带图标、不 import React）：store、设置页、根路由重定向都能安全引用，
 * 不会因为「引一个图标」把组件层拖进状态层。图标在 `shell/mobile/nav.tsx` 里按 key 映射。
 *
 * 导航形态是**左侧抽屉**（不是底部 tab）：手机上要给列表留满宽，底部只留常驻播放条。
 */
export interface MobileNavEntry {
    key: string;
    path: string;
    labelKey: string;
}

/** 抽屉里的导航项（第一个是默认 home；顺序即显示顺序） */
export const MOBILE_NAV_ENTRIES: MobileNavEntry[] = [
    {key: 'search', path: '/search', labelKey: 'nav.search'},
    {key: 'local', path: '/local', labelKey: 'nav.local'},
    {key: 'download', path: '/download', labelKey: 'nav.download'},
    {key: 'recent', path: '/recent', labelKey: 'nav.recent'},
    {key: 'favorites', path: '/favorites', labelKey: 'sidebar.favorites'},
    {key: 'plugin', path: '/plugin', labelKey: 'nav.plugin'},
    {key: 'theme', path: '/theme', labelKey: 'nav.theme'},
    {key: 'setting', path: '/setting', labelKey: 'nav.setting'},
];

/** 手机上的默认 home 路由（根路径重定向到这里；用户可在设置页改） */
export const MOBILE_HOME_PATH = '/search';

/**
 * 归一化用户选的「主页」：只接受导航表里真实存在的路径。
 *
 * 持久化数据可能来自旧版本 / 手改 localStorage，不能直接 `navigate`——
 * 一个不存在的 path 会让根路径重定向到 404（或者更糟：空白页）。
 */
export function normalizeMobileHomePath(value: unknown): string {
    return typeof value === 'string' && MOBILE_NAV_ENTRIES.some((entry) => entry.path === value)
        ? value
        : MOBILE_HOME_PATH;
}
