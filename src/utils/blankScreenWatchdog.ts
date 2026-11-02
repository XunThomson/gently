/**
 * 「白屏」看门狗（R137 第三轮）。
 *
 * 用户反馈：切换「列表展示方式」后界面变白，但**没有任何报错**——错误边界/全局错误面板都抓不到。
 * 那种情况下 DOM 还在，只是看起来是空的（也可能文字与背景同色）。既然没有异常，就**主动检测**：
 *
 * - 每隔一段时间（以及可见性变化时）检查页面是否「看起来是空的」：
 *   `#root` 没有任何元素，或主内容区的可见文本长度接近 0，且持续超过阈值；
 * - 命中后弹一条**非模态**的小横幅（不遮挡界面），把当时的诊断信息记下来：
 *   路由、视口/滚动尺寸、html/body/main 的实际背景色与文字色、`localStorage` 里的偏好、
 *   store 里与设置相关的值（列表展示方式 / 主题 / 音源筛选）。
 *
 * 诊断横幅存在的原因：白屏没有滚动条、没有焦点，用户除了「它白了」什么也说不出；
 * 有了这段文本，就能判断是「根本没渲染」还是「渲染了但看不见」（颜色/透明度/层级）。
 *
 * 样式一律内联、固定色值：走到这一步时主题变量可能根本没注入。
 */

const BANNER_ID = 'gently-blank-banner';
/** 连续空白多久才报（避开换页、加载中的正常空档） */
const BLANK_FOR_MS = 1800;
/** 主内容区少于这么多字符就算「看起来是空的」 */
const MIN_VISIBLE_TEXT = 8;
/** 启动后这段时间内不判断（首屏本来就有空档） */
const STARTUP_GRACE_MS = 4000;
const TICK_MS = 400;

let blankSince = 0;
let bannerVisible = false;
let lastReport = '';

function visibleTextLength(): number {
    const root = document.getElementById('root');
    if (!root) return 0;
    const text = (root.innerText || '').replace(/\s+/g, '');
    return text.length;
}

/** 把 `rgb()/rgba()` 解析成 [r,g,b,a]；解析不了返回 null */
function parseColor(value: string): [number, number, number, number] | null {
    const match = /rgba?\(([^)]+)\)/.exec(value);
    if (!match) return null;
    const parts = match[1].split(',').map((part) => Number(part.trim()));
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

/** 往上找第一个「不透明」的背景色：body 通常透明，真正上色的是 html 或某个外壳容器 */
function effectiveBackground(element: Element): [number, number, number, number] | null {
    let current: Element | null = element;
    while (current) {
        const style = getComputedStyle(current);
        /* 背景图/渐变的元素不算「纯色背景」：图片上的白字是正常的，不能判成看不见 */
        if (style.backgroundImage && style.backgroundImage !== 'none') return null;
        const color = parseColor(style.backgroundColor);
        if (color && color[3] > 0.05) return color;
        current = current.parentElement;
    }
    return null;
}

/**
 * 「有文字但看不见」的判定：挑几个真正承载文字的叶子元素，逐个比对
 * 文字色 vs 它背后第一个不透明背景色；**全部**看不清才算白屏。
 *
 * 只比 `#root` 自己的 color 不够：页面里每个元素基本都有自己的颜色 token，
 * 白字白底往往只出现在文字所在的那一层（R137 用户反馈的正是「没报错的白」）。
 */
function invisibleTextReason(): string | null {
    const root = document.getElementById('root');
    if (!root) return null;

    const candidates = [...root.querySelectorAll<HTMLElement>('p, span, button, a, label, h1, h2, h3, li, strong, small, summary')]
        .filter((element) => {
            const text = (element.textContent ?? '').trim();
            if (!text) return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 4 && rect.height > 4;
        })
        .slice(0, 12);
    if (candidates.length < 3) return null;

    let invisible = 0;
    let sample = '';
    for (const element of candidates) {
        const style = getComputedStyle(element);
        if (Number(style.opacity) === 0 || style.visibility === 'hidden') {
            invisible += 1;
            sample = `${element.tagName} 不可见（opacity/visibility）`;
            continue;
        }
        const textColor = parseColor(style.color);
        const background = effectiveBackground(element);
        if (!textColor || !background) continue;
        const distance =
            Math.abs(textColor[0] - background[0]) +
            Math.abs(textColor[1] - background[1]) +
            Math.abs(textColor[2] - background[2]);
        if (distance < 24) {
            invisible += 1;
            sample = `${element.tagName}「${(element.textContent ?? '').trim().slice(0, 12)}」${style.color} on rgb(${background[0]},${background[1]},${background[2]})`;
        }
    }

    /* 抽样元素里绝大多数都看不清 → 判定「渲染了但看不见」 */
    if (invisible >= Math.max(3, Math.ceil(candidates.length * 0.8))) {
        return `文字与背景几乎同色（例：${sample}）`;
    }
    return null;
}

/**
 * 判断「看起来是空的」。
 *
 * 三类都要认（用户报的是「白屏且没有报错」，所以不能只认 `#root` 真的为空）：
 * 1. 根本没什么文字（`#root` 的可见文本接近 0）；
 * 2. 有文字但**看不见**：文字色与背景色几乎一样，或整棵树被 `opacity: 0` / `display:none` 掉；
 * 3. 主内容区高度塌成 0（有 DOM 但没布局）。
 *
 * 返回原因（写进诊断），不空白则返回 `null`。
 */
export function blankScreenReason(): string | null {
    const root = document.getElementById('root');
    if (!root) return '没有 #root 节点';
    const rootStyle = getComputedStyle(root);
    if (rootStyle.display === 'none') return '#root 的 display 是 none';
    if (Number(rootStyle.opacity) === 0) return '#root 的 opacity 是 0';

    const text = visibleTextLength();
    if (text < MIN_VISIBLE_TEXT) return `可见文本只有 ${text} 个字符`;

    const main = document.querySelector('main');
    if (main && main.getBoundingClientRect().height < 40) {
        return `main 高度只有 ${Math.round(main.getBoundingClientRect().height)}px`;
    }

    /* 有文字：再看它是不是「看见的全是同色」 */
    return invisibleTextReason();
}

/**
 * 采集诊断信息（纯文本：用户点「复制」拿到的就是它）。
 * 只读 DOM / localStorage，不调用任何 IPC——白屏时连核心是否可用都未必知道。
 */
export function collectBlankScreenDiagnostic(): string {
    const root = document.getElementById('root');
    const main = document.querySelector('main');
    const describe = (element: Element | null): string => {
        if (!element) return '(不存在)';
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return [
            `children=${element.childElementCount}`,
            `text=${(element as HTMLElement).innerText?.replace(/\s+/g, '').length ?? -1}`,
            `box=${Math.round(rect.width)}x${Math.round(rect.height)}`,
            `bg=${style.backgroundColor}`,
            `color=${style.color}`,
            `opacity=${style.opacity}`,
            `display=${style.display}`,
            `visibility=${style.visibility}`,
        ].join(' ');
    };

    let stored = '';
    try {
        stored = localStorage.getItem('gently:ui') ?? '(空)';
    } catch (err) {
        stored = `(读不到 localStorage: ${String(err)})`;
    }

    return [
        `时间：${new Date().toISOString()}`,
        `路由：${location.pathname}${location.search}`,
        `视口：${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`,
        `文档：scrollHeight=${document.body?.scrollHeight ?? -1} clientHeight=${document.documentElement.clientHeight}`,
        `html：${describe(document.documentElement)}`,
        `body：${describe(document.body)}`,
        `#root：${describe(root)}`,
        `main：${describe(main)}`,
        `#root 首个子元素：${root?.firstElementChild ? root.firstElementChild.tagName + '.' + String((root.firstElementChild as HTMLElement).className) : '(无)'}`,
        `localStorage[gently:ui]：${stored}`,
        `data-shell=${document.documentElement.dataset.shell ?? '(无)'} data-window=${document.documentElement.dataset.window ?? '(无)'}`,
    ].join('\n');
}

function showBanner(reason: string): void {
    if (typeof document === 'undefined' || !document.body) return;

    const diagnostic = `判定：${reason}\n${collectBlankScreenDiagnostic()}`;
    lastReport = diagnostic;
    /* 同一段诊断不重复刷屏：内容没变就走 */
    if (bannerVisible) {
        const pre = document.querySelector(`#${BANNER_ID} pre`);
        if (pre) pre.textContent = diagnostic;
        return;
    }
    bannerVisible = true;

    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.setAttribute('role', 'status');
    banner.style.cssText = [
        'position:fixed',
        'left:12px',
        'right:12px',
        'bottom:12px',
        'z-index:2147483646',
        'box-sizing:border-box',
        'padding:12px 14px',
        'border-radius:12px',
        'border:1px solid #e4e4e7',
        'background:#ffffff',
        'color:#111111',
        'box-shadow:0 12px 28px rgba(17,24,39,.18)',
        'font:13px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    ].join(';');
    banner.innerHTML = `
        <div style="font-weight:600;margin-bottom:4px">界面看起来是空白的</div>
        <div style="color:#52525b;margin-bottom:8px">我们已经把当时的诊断信息记下来了（没有报错也能看）。点「复制诊断信息」把它发给开发者，就能定位是没渲染还是看不见。</div>
        <details style="margin-bottom:8px">
            <summary style="cursor:pointer;color:#52525b">展开诊断信息</summary>
            <pre style="white-space:pre-wrap;word-break:break-word;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:10px;margin:8px 0 0;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace">${escapeHtml(diagnostic)}</pre>
        </details>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" data-action="copy" style="padding:6px 12px;border-radius:8px;border:1px solid #2563eb;background:#2563eb;color:#fff;font:inherit;cursor:pointer">复制诊断信息</button>
            <button type="button" data-action="reload" style="padding:6px 12px;border-radius:8px;border:1px solid #d4d4d8;background:#fafafa;color:#111;font:inherit;cursor:pointer">重新加载</button>
            <button type="button" data-action="dismiss" style="padding:6px 12px;border-radius:8px;border:1px solid transparent;background:transparent;color:#52525b;font:inherit;cursor:pointer">关掉</button>
        </div>
    `;
    banner.addEventListener('click', (event) => {
        const action = (event.target as HTMLElement | null)?.dataset?.action;
        if (action === 'reload') window.location.reload();
        else if (action === 'dismiss') {
            banner.remove();
            bannerVisible = false;
            blankSince = 0;
        } else if (action === 'copy') {
            void copyDiagnostic(diagnostic);
        }
    });
    document.body.appendChild(banner);
    console.warn('[gently:blank] 界面看起来是空的', diagnostic);
}

async function copyDiagnostic(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch {
        /* 没有剪贴板权限：把文本选中，用户可长按复制 */
        const pre = document.querySelector(`#${BANNER_ID} pre`);
        const selection = window.getSelection();
        if (pre && selection) {
            const range = document.createRange();
            range.selectNodeContents(pre);
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 在入口挂一次（只有主窗口需要：歌词窗/宠物窗没有「页面」） */
export function installBlankScreenWatchdog(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const startedAt = Date.now();
    window.setInterval(() => {
        if (Date.now() - startedAt < STARTUP_GRACE_MS) return;
        if (document.visibilityState === 'hidden') return;

        const reason = blankScreenReason();
        if (!reason) {
            blankSince = 0;
            return;
        }
        if (blankSince === 0) {
            blankSince = Date.now();
            return;
        }
        if (Date.now() - blankSince < BLANK_FOR_MS) return;
        showBanner(reason);
    }, TICK_MS);
}

/** 给冒烟 / 诊断页读的最后一次报告（真机排查时也能从控制台拿） */
export function lastBlankScreenReport(): string {
    return lastReport;
}
