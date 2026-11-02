/**
 * 点一下播放条的「播放/暂停」，回报按钮标签翻没翻、有没有 JS 异常。
 *
 *   node scripts/android-cdp.mjs eval --file scripts/probes/playbar-toggle.js
 *
 * 为什么要装错误捕获：`eval` 只拿到返回值，事件处理里抛的异常会静默消失；
 * 而「点了没反应」在真机上最常见的两个原因就是异常与没点到（点没点到看 geometry 探针）。
 * 注意按 **aria-label 精确匹配**：播放条上还有一个「打开播放页」按钮，模糊匹配会点到它。
 */
(async () => {
    const caught = [];
    const onError = (e) => caught.push('error:' + (e.message || e.reason));
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onError);
    const originalError = console.error;
    console.error = (...args) => {
        caught.push('console.error:' + args.map((a) => String(a)).join(' ').slice(0, 300));
        originalError.apply(console, args);
    };

    const target = Array.from(document.querySelectorAll('button[aria-label]')).find(
        (b) => b.getAttribute('aria-label') === '暂停' || b.getAttribute('aria-label') === '播放',
    );
    const before = target?.getAttribute('aria-label');
    target?.click();
    await new Promise((r) => setTimeout(r, 400));
    const after = Array.from(document.querySelectorAll('button[aria-label]'))
        .map((b) => b.getAttribute('aria-label'))
        .filter(Boolean)
        .join(',');

    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onError);
    console.error = originalError;
    const slider = document.querySelector('[role=slider]');
    return JSON.stringify({
        before,
        after,
        caught,
        now: slider?.getAttribute('aria-valuenow'),
        max: slider?.getAttribute('aria-valuemax'),
    });
})();
