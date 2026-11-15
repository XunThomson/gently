/**
 * 「最后一次所在页面」（R144）。
 *
 * 页面被 WebView 因内存/后台策略重载时，路由会回到 `/`，用户看起来就是
 * 「软件刷新了、状态丢了」。这里用 `sessionStorage`（**只跨 reload / 恢复**，
 * 不跨真正的冷启动）记住最后的路由，重载时回到原页。
 *
 * 不写 localStorage：冷启动后停在设置页很怪；`sessionStorage` 的生命周期
 * 正好等于「这个 WebView 会话」，与我们要修的「后台回来重载」一致。
 */
const KEY = 'gently:last-route';
const BOOT_KEY = 'gently:route-boot';
const SNAPSHOT_KEY = 'gently:last-route-snapshot';
/** 后台被杀后进程重启：多久以内回到原页仍算「恢复」而不是冷启动 */
export const RESUME_ROUTE_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * 本次页面加载之前，这个 WebView 会话里是否已经渲染过一次。
 *
 * 比 `performance.navigation.type` 可靠：WebView 被系统丢弃后恢复时，
 * 有时是一次普通的 `navigate`，但 sessionStorage 还在。第一次加载时写入标记，
 * 之后（reload / 恢复）读到 true。模块只在每次页面加载时执行一次。
 */
const bootedBefore = (() => {
    try {
        if (typeof window === 'undefined') return false;
        const before = window.sessionStorage.getItem(BOOT_KEY) === '1';
        window.sessionStorage.setItem(BOOT_KEY, '1');
        return before;
    } catch {
        return false;
    }
})();

/** 是否是「同一会话里的再次加载」（reload / WebView 恢复），而不是真正的冷启动 */
export function isSessionResume(): boolean {
    return bootedBefore || isRestoredNavigation();
}

function safeStorage(): Storage | null {
    try {
        if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
        /* 冒烟测试在 Node 里把 Storage 挂到 globalThis（与 localStorage 的既有做法一致） */
        const scope = globalThis as unknown as {sessionStorage?: Storage};
        return scope.sessionStorage ?? null;
    } catch {
        return null;
    }
}

/** 记住当前页面（pathname + search；不记 hash，应用不用 hash 路由） */
export function rememberLastRoute(pathnameAndSearch: string): void {
    if (!pathnameAndSearch.startsWith('/')) return;
    try {
        safeStorage()?.setItem(KEY, pathnameAndSearch);
        /* R145：另存一份带时间戳的 localStorage 快照。Android/Windows 把 WebView
           进程整个杀掉时 sessionStorage 可能一起没了，但 localStorage 还在；
           30 分钟内重新打开回到原页，超过就按冷启动回首页。 */
        safeLocalStorage()?.setItem(
            SNAPSHOT_KEY,
            JSON.stringify({path: pathnameAndSearch, at: Date.now()}),
        );
    } catch {
        /* 隐私模式 / 配额：忽略 */
    }
}

/** 读出上次页面；非法值返回 null */
export function readLastRoute(): string | null {
    try {
        const raw = safeStorage()?.getItem(KEY);
        if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null;
        return raw;
    } catch {
        return null;
    }
}

/** 进程被杀后仍可用的最近页面；超过 maxAge 视为冷启动 */
export function readRecentRoute(maxAgeMs = RESUME_ROUTE_MAX_AGE_MS): string | null {
    try {
        const raw = safeLocalStorage()?.getItem(SNAPSHOT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {path?: unknown; at?: unknown};
        const path = typeof parsed.path === 'string' ? parsed.path : '';
        const at = typeof parsed.at === 'number' ? parsed.at : 0;
        if (!path.startsWith('/') || path.startsWith('//')) return null;
        if (!Number.isFinite(at) || Date.now() - at > maxAgeMs) return null;
        return path;
    } catch {
        return null;
    }
}

function safeLocalStorage(): Storage | null {
    try {
        if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
        const scope = globalThis as unknown as {localStorage?: Storage};
        return scope.localStorage ?? null;
    } catch {
        return null;
    }
}

/**
 * 本次加载是不是「重载 / 前进后退恢复」。
 *
 * 只有这两种情况才恢复上次页面；真正的冷启动（`navigate`）仍然走默认首页。
 * 老浏览器没有 `PerformanceNavigationTiming` 时返回 false（宁可回首页）。
 */
export function isRestoredNavigation(): boolean {
    try {
        const entry = performance.getEntriesByType('navigation')[0] as
            | PerformanceNavigationTiming
            | undefined;
        return entry?.type === 'reload' || entry?.type === 'back_forward';
    } catch {
        return false;
    }
}
