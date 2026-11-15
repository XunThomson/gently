/**
 * 手机歌词页「上划打开侧边抽屉」的轻量事件（R145）。
 *
 * 歌词页与 MobileShell 是两个组件，且歌词页不直接持有 drawer 状态；
 * 用一个只读事件把「请求打开」传上去，比把 setDrawerOpen 层层透传更干净。
 * 事件名按应用内 window 事件约定（不是 Tauri 事件，不受字符集限制）。
 */
export const MOBILE_DRAWER_OPEN_EVENT = 'gently:mobile-drawer:open';

export function requestMobileDrawer(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new Event(MOBILE_DRAWER_OPEN_EVENT));
}
