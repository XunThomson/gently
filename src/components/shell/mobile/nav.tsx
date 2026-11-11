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
import {MOBILE_NAV_ENTRIES, MOBILE_HOME_PATH} from '../../../config/mobileNav';

/**
 * 移动外壳的导航定义（**一条数据**，不在每个视图里各写一遍）。
 *
 * 路径 / 文案键的唯一来源是 `src/config/mobileNav.ts`（store 与路由重定向也会读它）；
 * 这里只负责按 key 配图标、并给出抽屉要用的 React 节点。
 *
 * 安卓端**不做推荐与排行榜**（用户 2026-11-01 决定），导航只有：
 * 搜索（home）/ 本地 / 下载 / 最近 / 收藏 / 插件 / 主题 / 设置。
 */
export interface MobileNavItem {
    key: string;
    path: string;
    labelKey: string;
    icon: ReactNode;
}

/** key → 图标（key 与 `MOBILE_NAV_ENTRIES` 一一对应） */
const NAV_ICONS: Record<string, ReactNode> = {
    search: <IconSearch size={18}/>,
    local: <IconFolder size={18}/>,
    download: <IconDownload size={18}/>,
    recent: <IconClock size={18}/>,
    favorites: <IconHeart size={18}/>,
    plugin: <IconPuzzle size={18}/>,
    theme: <IconPalette size={18}/>,
    setting: <IconGear size={18}/>,
};

/** 抽屉里的导航项（第一个是 home；顺序即显示顺序） */
export const mobileNavItems: MobileNavItem[] = MOBILE_NAV_ENTRIES.map((entry) => ({
    ...entry,
    icon: NAV_ICONS[entry.key] ?? <IconSearch size={18}/>,
}));

/** 手机上的 home 路由（根路径重定向到这里，见 `router/index.tsx`） */
export {MOBILE_HOME_PATH};

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
