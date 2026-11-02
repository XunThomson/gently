/**
 * 前端出错的**兜底层**（R137）。
 *
 * 为什么需要：设置页曾经出现「改一项设置就白屏」，而白屏时现场什么都没留下——
 * 没有提示、没有栈、用户只能说「它白了」。这里做两件事：
 * 1. `installErrorOverlay()`：在 `main.tsx` 里挂 `window.error` 与 `unhandledrejection`，
 *    出现未捕获错误时直接往 DOM 上插一张**原生**面板（不依赖 React、不依赖主题变量），
 *    显示原因 + 出错位置，并提供「复制」与「重新加载」；
 * 2. `<RootError>`：包在整棵树外面，渲染期抛错（连 ThemeProvider 内部也算）也能兜住，
 *    同样是可读的错误页，而不是白屏。
 *
 * 面板样式刻意用内联的少量固定色值（不读主题 token）：走到这一步时主题变量可能根本没注入，
 * 读 token 只会让文字变透明、继续「白屏」。
 */

const OVERLAY_ID = 'gently-error-overlay';

/** 最近一次捕获到的错误（诊断按钮 / 控制台都能读它） */
let lastError: {title: string; detail: string; at: string} | null = null;

export function getLastError(): typeof lastError {
    return lastError;
}

/** 把错误记下来并显示兜底面板（重复错误只更新内容，不叠好几张） */
export function reportFatalError(title: string, detail: string): void {
    lastError = {title, detail, at: new Date().toISOString()};
    /* 控制台留一条：真机接 CDP 时能直接读到；不影响面板 */
    console.error(`[gently:error] ${title}`, detail);

    if (typeof document === 'undefined' || !document.body) return;
    const existing = document.getElementById(OVERLAY_ID);
    const panel = existing ?? document.createElement('div');

    panel.id = OVERLAY_ID;
    panel.setAttribute('role', 'alert');
    /* 内联样式而不是 class：此时主样式表/主题变量可能不可用，必须自带可读的配色 */
    panel.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:flex',
        'flex-direction:column',
        'gap:12px',
        'padding:24px',
        'box-sizing:border-box',
        'background:#ffffff',
        'color:#111111',
        'font:14px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
        'overflow:auto',
    ].join(';');

    panel.innerHTML = `
        <div style="font-size:16px;font-weight:600">${escapeHtml(title)}</div>
        <div style="color:#555">这是应用自己捕获到的错误（不是系统弹窗）。复制下面这段信息发给开发者即可定位；也可以重新加载继续用。</div>
        <pre style="white-space:pre-wrap;word-break:break-word;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:12px;margin:0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(detail)}</pre>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
            <button type="button" data-action="copy" style="padding:8px 14px;border-radius:8px;border:1px solid #d4d4d8;background:#fafafa;font:inherit;cursor:pointer">复制出错信息</button>
            <button type="button" data-action="reload" style="padding:8px 14px;border-radius:8px;border:1px solid #2563eb;background:#2563eb;color:#fff;font:inherit;cursor:pointer">重新加载</button>
            <button type="button" data-action="dismiss" style="padding:8px 14px;border-radius:8px;border:1px solid transparent;background:transparent;color:#555;font:inherit;cursor:pointer">先关掉</button>
        </div>
    `;

    if (!existing) {
        panel.addEventListener('click', (event) => {
            const action = (event.target as HTMLElement | null)?.dataset?.action;
            if (action === 'reload') window.location.reload();
            else if (action === 'dismiss') panel.remove();
            else if (action === 'copy') void copyText(`${title}\n${detail}`);
        });
        document.body.appendChild(panel);
    }
}

async function copyText(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch {
        /* 没有剪贴板权限（或不是安全上下文）：退回选中文本，让用户自己长按复制 */
        const selection = window.getSelection();
        const range = document.createRange();
        const pre = document.querySelector(`#${OVERLAY_ID} pre`);
        if (pre && selection && range) {
            range.selectNodeContents(pre);
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 在 `main.tsx` 里挂一次：未捕获错误 / 未处理的 Promise 拒绝都不再是「静默白屏」 */
export function installErrorOverlay(): void {
    if (typeof window === 'undefined') return;

    window.addEventListener('error', (event) => {
        const error = (event as ErrorEvent).error;
        const message = (event as ErrorEvent).message || String(error ?? '未知错误');
        reportFatalError('页面出错了', `${message}\n${error?.stack ?? ''}\n${location.href}`);
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = (event as PromiseRejectionEvent).reason;
        const text =
            reason instanceof Error
                ? `${reason.message}\n${reason.stack ?? ''}`
                : typeof reason === 'string'
                  ? reason
                  : safeJson(reason);
        reportFatalError('有一个操作失败了', `${text}\n${location.href}`);
    });
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
