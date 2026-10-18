/**
 * 桌面窗口能力封装。
 *
 * 浏览器 / `vite dev` 环境下所有方法都是安全的空操作，
 * 只有在 Tauri 宿主里才会真正调用原生窗口 API（动态导入，避免无谓的体积）。
 */

import {appConfig} from '../config/app.config';
import {placeLyrics, type Position} from '../utils/lyricsWindowPosition';

export const isTauri = (): boolean =>
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 桌面歌词窗口（`tauri.conf.json` 里的 label；启动时隐藏，按需显示） */
export const DESKTOP_LYRICS_LABEL = 'desktop-lyrics';

/** 用户拖动后记住的窗口坐标（localStorage；两个窗口同源，写读共享） */
export const LYRICS_POSITION_KEY = 'gently:lyrics-window-pos';

/**
 * 「锁定歌词窗口（鼠标点击穿透）」的持久化键。
 *
 * 为什么锁定状态必须能在**主窗口**里改：锁定之后歌词窗口自己收不到任何鼠标事件，
 * 等于它自己被锁死——解锁入口只能放在主窗口（设置页），否则用户再也解不开。
 */
export const LYRICS_LOCKED_KEY = 'gently:lyrics-locked';

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
                // 先记位置再隐藏：用户拖到哪，下次显示就还在哪
                await rememberLyricsPosition(win);
                await win.hide();
                return false;
            }
            await placeLyricsWindow(win);
            await win.show();
            // 锁定状态是持久化的：窗口重建后也要重新应用（否则重启就「解锁」了）
            await applyLyricsLock(win);
            return true;
        } catch (err) {
            console.warn('[window] 切换桌面歌词窗口失败', err);
            return null;
        }
    },

    /** 歌词窗口是否处于「锁定（点击穿透）」状态 */
    desktopLyricsLocked: (): boolean => readLyricsLocked(),

    /**
     * 锁定 / 解锁歌词窗口：锁定后鼠标点击**穿透**到下面的窗口，歌词条不再挡路。
     *
     * 解锁入口只在设置页——锁定之后歌词窗口自己收不到点击，不能靠它自己的按钮解锁。
     */
    setDesktopLyricsLocked: async (locked: boolean): Promise<boolean> => {
        writeLyricsLocked(locked);
        if (!isTauri()) return locked;
        try {
            const win = await lyricsWindow();
            if (win) await win.setIgnoreCursorEvents(locked);
        } catch (err) {
            console.warn('[window] 设置歌词窗口点击穿透失败', err);
        }
        return locked;
    },

    /** 隐藏桌面歌词窗口（歌词窗口自己的关闭按钮也用它） */
    hideDesktopLyrics: async (): Promise<void> => {
        if (!isTauri()) return;
        try {
            const win = await lyricsWindow();
            if (win) {
                await rememberLyricsPosition(win);
                await win.hide();
            }
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
 * 摆放歌词窗口：**优先用用户上次拖动后的位置**，没记过 / 不可见才回到底部居中。
 *
 * 判断逻辑在 `utils/lyricsWindowPosition.ts`（纯函数，与冒烟测试同一份实现）：
 * 副屏被拔、分辨率变了都会自动回退，不会把窗口放到看不见的地方。
 */
async function placeLyricsWindow(win: LyricsWindow): Promise<void> {
    try {
        const {availableMonitors, PhysicalPosition} = await import('@tauri-apps/api/window');
        const [monitors, size] = await Promise.all([availableMonitors(), win.outerSize()]);
        const rects = monitors.map((monitor) => ({
            position: monitor.position,
            size: monitor.size,
        }));
        const position = placeLyrics(readLyricsPosition(), rects, size);
        await win.setPosition(new PhysicalPosition(position.x, position.y));
    } catch (err) {
        console.warn('[window] 摆放桌面歌词窗口失败（保持默认位置）', err);
    }
}

/**
 * 把持久化的锁定状态**同步**到窗口上（每次显示之后调用；失败只记日志）。
 *
 * 注意这里是 true / false 都写：`setIgnoreCursorEvents` 失败时我们没法查询窗口的真实状态，
 * 而每次显示都重新同步一遍，就能让「设置里改了但窗口没跟上」在下一次显示时自愈——
 * 否则用户一旦锁上、解锁调用又失败，就再也点不到歌词条上的任何按钮了。
 */
async function applyLyricsLock(win: LyricsWindow): Promise<void> {
    try {
        await win.setIgnoreCursorEvents(readLyricsLocked());
    } catch (err) {
        console.warn('[window] 同步歌词窗口点击穿透失败', err);
    }
}

/**
 * 取 localStorage：**没有就返回 null**（Node 里的冒烟测试、SSR）。
 *
 * 不直接写 `localStorage.xxx`：在 Node 里那会抛 `ReferenceError` 而不是被 catch 到，
 * 于是「读一眼设置」就能把整个页面渲染打断。
 */
function storage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

function readLyricsLocked(): boolean {
    return storage()?.getItem(LYRICS_LOCKED_KEY) === '1';
}

function writeLyricsLocked(locked: boolean): void {
    try {
        storage()?.setItem(LYRICS_LOCKED_KEY, locked ? '1' : '0');
    } catch (err) {
        console.warn('[window] 保存歌词窗口锁定状态失败', err);
    }
}

/** 隐藏前把当前坐标记下来（用户拖到哪，下次就还在哪）。 */
async function rememberLyricsPosition(win: LyricsWindow): Promise<void> {
    try {
        const position = await win.outerPosition();
        writeLyricsPosition({x: position.x, y: position.y});
    } catch (err) {
        console.warn('[window] 记录桌面歌词窗口位置失败', err);
    }
}

function readLyricsPosition(): Position | null {
    try {
        const raw = storage()?.getItem(LYRICS_POSITION_KEY);
        if (!raw) return null;
        const value = JSON.parse(raw) as Partial<Position> | null;
        if (!value || typeof value.x !== 'number' || typeof value.y !== 'number') return null;
        return {x: value.x, y: value.y};
    } catch {
        // 存坏了就当作没记过（回到底部居中），不要让一条坏数据挡住歌词窗口
        return null;
    }
}

function writeLyricsPosition(position: Position): void {
    try {
        storage()?.setItem(LYRICS_POSITION_KEY, JSON.stringify(position));
    } catch (err) {
        console.warn('[window] 保存桌面歌词窗口位置失败', err);
    }
}
