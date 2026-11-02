/**
 * 读播放条的状态：按钮标签、进度、时长、末尾几行文案。
 *
 *   node scripts/android-cdp.mjs eval --file scripts/probes/playbar-state.js
 *
 * 为什么用它而不是截图数像素：真机上「在播 / 暂停 / 时长」全在 aria 属性与按钮标签里，
 * 直接读比人眼看图可靠，也方便前后对比（例如通知栏位置有没有跟着 store 走）。
 */
(() => {
    const labels = Array.from(document.querySelectorAll('button'))
        .map((b) => b.getAttribute('aria-label'))
        .filter(Boolean);
    const slider = document.querySelector('[role=slider]');
    return JSON.stringify({
        labels,
        now: slider?.getAttribute('aria-valuenow'),
        max: slider?.getAttribute('aria-valuemax'),
        tail: document.body.innerText.split('\n').slice(-6),
    });
})();
