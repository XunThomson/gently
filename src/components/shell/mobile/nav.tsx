import type {ReactNode} from 'react';
import {
    IconClock,
    IconDownload,
    IconFolder,
    IconGear,
    IconHeart,
    IconPalette,
    IconPuzzle,
    IconSearch,
} from '../../ui/icon';

/**
 * 移动外壳的导航定义（**一条数据**，不在每个视图里各写一遍）。
 *
 * 安卓端**不做推荐与排行榜**（用户 2026-11-01 决定），导航只有：
 * 搜索（home）/ 本地 / 下载 / 最近 / 收藏 / 插件 / 主题 / 设置。
 * 导航形态是**左侧抽屉**（不是底部 tab）：手机上要给列表留满宽，
 * 底部只留常驻播放条。
 */
export interface MobileNavItem {
    key: string;
    path: string;
    labelKey: string;
    icon: ReactNode;
}

/** 抽屉里的导航项（第一个是 home；顺序即显示顺序） */
export const mobileNavItems: MobileNavItem[] = [
    {key: 'search', path: '/search', labelKey: 'nav.search', icon: <IconSearch size={18}/>},
    {key: 'local', path: '/local', labelKey: 'nav.local', icon: <IconFolder size={18}/>},
    {key: 'download', path: '/download', labelKey: 'nav.download', icon: <IconDownload size={18}/>},
    {key: 'recent', path: '/recent', labelKey: 'nav.recent', icon: <IconClock size={18}/>},
    {key: 'favorites', path: '/favorites', labelKey: 'sidebar.favorites', icon: <IconHeart size={18}/>},
    {key: 'plugin', path: '/plugin', labelKey: 'nav.plugin', icon: <IconPuzzle size={18}/>},
    {key: 'theme', path: '/theme', labelKey: 'nav.theme', icon: <IconPalette size={18}/>},
    {key: 'setting', path: '/setting', labelKey: 'nav.setting', icon: <IconGear size={18}/>},
];

/** 手机上的 home 路由（根路径重定向到这里，见 `router/index.tsx`） */
export const MOBILE_HOME_PATH = '/search';

/**
 * 当前路由属于哪一项（用于抽屉里高亮）。
 *
 * 用 `startsWith` 而不是全等：`/download/downloading` 这类子路径
 * 也算在父项上。
 */
export function activeNavKey(pathname: string): string | null {
    const hit = mobileNavItems.find(
        (item) => pathname === item.path || pathname.startsWith(`${item.path}/`),
    );
    return hit ? hit.key : null;
}
