/**
 * 桌面窗口能力封装。
 *
 * 浏览器 / `vite dev` 环境下所有方法都是安全的空操作，
 * 只有在 Tauri 宿主里才会真正调用原生窗口 API（动态导入，避免无谓的体积）。
 */

import {appConfig} from '../config/app.config';

export const isTauri = (): boolean =>
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 桌面歌词窗口（`tauri.conf.json` 里的 label；启动时隐藏，按需显示） */
export const DESKTOP_LYRICS_LABEL = 'desktop-lyrics';

/**
 * 主窗口 ↔ 桌面歌词窗口的**窗口间事件**（不是核心契约事件）。
 *
 * 事件名同样受 Tauri 字符集约束（只允许字母数字与 `- / : _`），所以用冒号分段。
 */
export const DESKTOP_LYRICS_EVENTS = {
    /** 主窗口 → 歌词窗口：当前曲目 / 当前行 / 下一行 / 是否在播 */
    update: 'gently:lyrics:update',
    /** 歌词窗口 → 主窗口：用户把它关了（主窗口据此恢复按钮状态） */
    closed: 'gently:lyrics:closed',
} as const;

async function currentWindow() {
    const {getCurrentWindow} = await import('@tauri-apps/api/window');
    return getCurrentWindow();
}

async function run(action: (win: Awaited<ReturnType<typeof currentWindow>>) => Promise<unknown>) {
    if (!isTauri()) return;
    try {
        await action(await currentWindow());
    } catch (err) {
        console.warn('[window] 原生窗口操作失败', err);
    }
}

export const windowService = {
    minimize: () => run((w) => w.minimize()),
    toggleMaximize: () => run((w) => w.toggleMaximize()),
    close: () => run((w) => w.close()),

    /**
     * 当前窗口是否最大化。
     * 浏览器 / `vite dev` 没有原生窗口，恒为 `false`（调用方据此渲染「最大化」图标）。
     */
    isMaximized: async (): Promise<boolean> => {
        if (!isTauri()) return false;
        try {
            return await (await currentWindow()).isMaximized();
        } catch (err) {
            console.warn('[window] 读取最大化状态失败', err);
            return false;
        }
    },

    /**
     * 订阅窗口尺寸变化（最大化 / 还原 / 拖拽缩放都会触发）。
     * 返回取消订阅函数；浏览器下是空操作。
     *
     * 为什么要订阅：标题栏的最大化图标必须跟着**真实窗口状态**走——
     * 用户双击无边框窗口的拖动区（Tauri 内置行为）也会最大化，不只是点按钮那一条路。
     */
    onResized: async (listener: () => void): Promise<() => void> => {
        if (!isTauri()) return () => undefined;
        try {
            return await (await currentWindow()).onResized(() => listener());
        } catch (err) {
            console.warn('[window] 订阅窗口尺寸变化失败', err);
            return () => undefined;
        }
    },
    setAlwaysOnTop: (value: boolean) => run((w) => w.setAlwaysOnTop(value)),
    /** 悬浮小窗：置顶 + 缩小尺寸 */
    setCompact: (value: boolean) =>
        run(async (w) => {
            const {LogicalSize} = await import('@tauri-apps/api/window');
            const {compact, normal} = appConfig.window;
            const size = value ? compact : normal;
            await w.setAlwaysOnTop(value);
            await w.setSize(new LogicalSize(size.width, size.height));
        }),

    /* ---------------- 桌面歌词窗口 ---------------- */

    /** 桌面歌词窗口当前是否可见；浏览器 / 没有该窗口时 `false` */
    desktopLyricsVisible: async (): Promise<boolean> => {
        if (!isTauri()) return false;
        try {
            const win = await lyricsWindow();
            return win ? await win.isVisible() : false;
        } catch (err) {
            console.warn('[window] 读取桌面歌词窗口状态失败', err);
            return false;
        }
    },

    /**
     * 显示 / 隐藏桌面歌词窗口。
     * 返回切换后的可见状态；`null` 表示没有 Tauri 宿主（浏览器预览）。
     */
    toggleDesktopLyrics: async (): Promise<boolean | null> => {
        if (!isTauri()) return null;
        try {
            const win = await lyricsWindow();
            if (!win) return null;
            if (await win.isVisible()) {
                await win.hide();
                return false;
            }
            await placeLyricsWindow(win);
            await win.show();
            return true;
        } catch (err) {
            console.warn('[window] 切换桌面歌词窗口失败', err);
            return null;
        }
    },

    /** 隐藏桌面歌词窗口（歌词窗口自己的关闭按钮也用它） */
    hideDesktopLyrics: async (): Promise<void> => {
        if (!isTauri()) return;
        try {
            const win = await lyricsWindow();
            if (win) await win.hide();
        } catch (err) {
            console.warn('[window] 隐藏桌面歌词窗口失败', err);
        }
    },
};

async function lyricsWindow() {
    const {WebviewWindow} = await import('@tauri-apps/api/webviewWindow');
    return WebviewWindow.getByLabel(DESKTOP_LYRICS_LABEL);
}

type LyricsWindow = NonNullable<Awaited<ReturnType<typeof lyricsWindow>>>;

/**
 * 每次显示时放到屏幕底部居中。
 *
 * 不做「记住上次位置」：窗口配置里 `center: true` 会让它在启动时回到屏幕中央，
 * 而用户对桌面歌词的默认预期就是贴着屏幕底部——统一每次摆放比「一半记住一半忘了」可预期。
 */
async function placeLyricsWindow(win: LyricsWindow): Promise<void> {
    try {
        const {currentMonitor, PhysicalPosition} = await import('@tauri-apps/api/window');
        const monitor = await currentMonitor();
        if (!monitor) return;
        const size = await win.outerSize();
        const x = monitor.position.x + Math.round((monitor.size.width - size.width) / 2);
        const y = monitor.position.y + monitor.size.height - size.height - 72;
        await win.setPosition(new PhysicalPosition(Math.max(0, x), Math.max(0, y)));
    } catch (err) {
        console.warn('[window] 摆放桌面歌词窗口失败（保持默认位置）', err);
    }
}
