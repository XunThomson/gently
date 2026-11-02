/**
 * 读所有带 `aria-label` 的按钮与进度条的**几何**（CSS 像素，CDP 点击用的就是这套坐标）。
 *
 *   node scripts/android-cdp.mjs eval --file scripts/probes/playbar-geometry.js
 *
 * 用途：`tap` 点不中时先看这里——是真没点到（坐标不在按钮里），还是点到了但没反应
 * （那就是事件处理的问题，换 playbar-toggle.js 看有没有异常）。
 */
(() => {
    const rect = (el) => {
        const r = el.getBoundingClientRect();
        return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
    };
    const buttons = Array.from(document.querySelectorAll('button[aria-label]')).map((b) => ({
        label: b.getAttribute('aria-label'),
        rect: rect(b),
        disabled: b.disabled,
    }));
    const slider = document.querySelector('[role=slider]');
    return JSON.stringify({
        viewport: {w: innerWidth, h: innerHeight, dpr: devicePixelRatio},
        buttons,
        slider: slider ? rect(slider) : null,
    });
})();
