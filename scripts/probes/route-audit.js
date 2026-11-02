/**
 * 移动端「每个路由都进得去、不横向溢出、没有报错」的一次性走查（验收用）。
 *
 *   node scripts/android-cdp.mjs eval --file scripts/probes/route-audit.js
 *
 * 为什么不用 `location.replace()`：那会**整页重载**（核心重新起、播放状态要重新恢复），
 * 走查 8 个页面要重载 8 次。react-router 听的是 `popstate`，pushState + 手动派发同一个事件
 * 就能走客户端路由，状态不丢。
 *
 * 每一步记录：路由、`scrollWidth` vs `width`（横向溢出）、抽屉/播放条在不在、
 * 页面里有没有「加载失败 / undefined / NaN」这类可疑文案、有没有新的 console.error。
 */
(async () => {
    const routes = [
        '/search',
        '/local',
        '/download',
        '/recent',
        '/favorites',
        '/plugin',
        '/theme',
        '/setting',
        '/now-playing',
    ];
    const errors = [];
    const onError = (event) => errors.push('error:' + (event.message || event.reason));
    const onRejection = (event) => errors.push('reject:' + String(event.reason));
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    const originalError = console.error;
    console.error = (...args) => {
        errors.push('console.error:' + args.map((a) => String(a)).join(' ').slice(0, 200));
        originalError.apply(console, args);
    };

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const results = [];
    for (const route of routes) {
        const before = errors.length;
        history.pushState({}, '', route);
        dispatchEvent(new PopStateEvent('popstate'));
        await wait(700);
        const text = document.body.innerText;
        results.push({
            route,
            path: location.pathname,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            width: window.innerWidth,
            height: window.innerHeight,
            hasShell: document.querySelector('[class*="shell"]') !== null,
            hasPlaybar: document.querySelector('[class*="playerBar"], [class*="bar"]') !== null,
            suspicious: ['加载失败', 'undefined', 'NaN', '失败：'].filter((word) =>
                text.includes(word),
            ),
            chars: text.length,
            newErrors: errors.slice(before),
        });
    }

    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    console.error = originalError;
    return JSON.stringify({results}, null, 1);
})();
