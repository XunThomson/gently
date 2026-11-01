/**
 * 桌面窗口能力封装。
 *
 * 浏览器 / `vite dev` 环境下所有方法都是安全的空操作，
 * 只有在 Tauri 宿主里才会真正调用原生窗口 API（动态导入，避免无谓的体积）。
 */

import {appConfig} from '../config/app.config';
import {placeLyrics, type Position} from '../utils/lyricsWindowPosition';
import {placePet} from '../utils/petWindowPosition';
import {isMobilePlatform} from '../utils/platform';

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

/**
 * 桌面专属的窗口动作（最小化 / 最大化 / 置顶 / 悬浮小窗 / 从迷你恢复）。
 *
 * 手机上这些按钮**根本不存在**（外壳是抽屉 + 单栏，没有标题栏），
 * 所以这里显式 no-op 并如实返回——不让 `setSize` / `setAlwaysOnTop` 打到一个
 * 安卓上不存在的窗口对象上（那只会留下一条「原生窗口操作失败」的日志，
 * 看起来像 bug，其实是调用了一个不该存在的入口）。
 */
export function desktopWindowActionsAvailable(
    tauri: boolean = isTauri(),
    mobile: boolean = isMobilePlatform(),
): boolean {
    return tauri && !mobile;
}

async function runDesktop(
    action: (win: Awaited<ReturnType<typeof currentWindow>>) => Promise<unknown>,
) {
    if (!desktopWindowActionsAvailable()) return;
    await run(action);
}

type NativeWindow = Awaited<ReturnType<typeof currentWindow>>;

/** 统一「改尺寸 + 置顶 + 可选居中」的顺序，避免两个入口各写一遍 */
async function applyWindowSize(
    win: NativeWindow,
    size: {width: number; height: number},
    options: {alwaysOnTop: boolean; center?: boolean},
): Promise<void> {
    const {LogicalSize} = await import('@tauri-apps/api/window');
    await win.setAlwaysOnTop(options.alwaysOnTop);
    await win.setSize(new LogicalSize(size.width, size.height));
    if (options.center) await win.center();
}

export const windowService = {
    minimize: () => runDesktop((w) => w.minimize()),
    toggleMaximize: () => runDesktop((w) => w.toggleMaximize()),
    close: () => run((w) => w.close()),

    /**
     * 当前窗口是否最大化。
     * 浏览器 / `vite dev` 没有原生窗口，恒为 `false`（调用方据此渲染「最大化」图标）。
     */
    isMaximized: async (): Promise<boolean> => {
        if (!isTauri() || isMobilePlatform()) return false;
        try {
            return await (await currentWindow()).isMaximized();
        } catch (err) {
            console.warn('[window] 读取最大化状态失败', err);
            return false;
        }
    },

    /**
     * 当前窗口是否置顶。
     * 浏览器 / `vite dev` 没有原生窗口，恒为 `false`。
     *
     * 用途：迷你模式由窗口尺寸触发，但用户也可能先点「画中画」再手动把窗口拖大；
     * 标题栏重新挂载时据此恢复按钮的按下态，而不是默认成未置顶。
     */
    isAlwaysOnTop: async (): Promise<boolean> => {
        if (!isTauri() || isMobilePlatform()) return false;
        try {
            return await (await currentWindow()).isAlwaysOnTop();
        } catch (err) {
            console.warn('[window] 读取置顶状态失败', err);
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
        /* 手机上没有可拖动的窗口边框：外壳宽度不随 resize 变化（形态只看平台），订阅没有意义 */
        if (!isTauri() || isMobilePlatform()) return () => undefined;
        try {
            return await (await currentWindow()).onResized(() => listener());
        } catch (err) {
            console.warn('[window] 订阅窗口尺寸变化失败', err);
            return () => undefined;
        }
    },
    setAlwaysOnTop: (value: boolean) => runDesktop((w) => w.setAlwaysOnTop(value)),
    /** 悬浮小窗：置顶 + 缩小尺寸 */
    setCompact: (value: boolean) =>
        runDesktop(async (w) => {
            const {compact, normal} = appConfig.window;
            await applyWindowSize(w, value ? compact : normal, {alwaysOnTop: value});
        }),

    /**
     * 从迷你播放器回到完整界面：恢复普通尺寸、取消置顶，并把窗口放回屏幕中间。
     *
     * 为什么单独一条而不是复用 `setCompact(false)`：迷你模式可能是用户**手动拖小**的，
     * 不一定是「悬浮小窗」；恢复时窗口可能停在屏幕角落，放大后有一半在屏幕外。
     * 居中一次能保证「展开」之后立刻看得见完整界面。
     */
    restoreFromMini: () =>
        runDesktop(async (w) => {
            await applyWindowSize(w, appConfig.window.normal, {
                alwaysOnTop: false,
                center: true,
            });
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

    /* ---------------- 宠物窗口（独立置顶小窗） ---------------- */

    /**
     * 显示宠物窗口。
     *
     * 为什么宠物要独立成窗口：留在主窗口里就注定「跟着音乐软件一起最小化、一起被盖住」，
     * 还要和音乐软件的浮层抢同一块像素。独立窗口之后，主窗口最小化它照样在桌面上，
     * 位置也不再受主窗口边界限制。
     */
    showPetWindow: async (): Promise<boolean> => {
        if (!isTauri()) return false;
        try {
            const win = await petWindow();
            if (!win) return false;
            await placePetWindow(win);
            await win.show();
            /* 锁定状态是持久化的：每次显示都重新同步一次（窗口重建后不会「自己解锁」） */
            const locked = windowService.petLocked();
            await win.setIgnoreCursorEvents(locked);
            void import('@tauri-apps/api/event').then(({emit}) => emit(PET_LOCK_EVENT, {locked}));
            /* 走动开关也要同步：宿主那边是常驻轮询，不知道前端存了什么 */
            void import('@tauri-apps/api/event').then(({emit}) =>
                emit(PET_ROAM_EVENT, {enabled: windowService.petRoam()}),
            );
            return true;
        } catch (err) {
            console.warn('[window] 显示宠物窗口失败', err);
            return false;
        }
    },

    /** 隐藏宠物窗口（保留窗口实例：下次显示更快，也不用重建 WebView） */
    hidePetWindow: async (): Promise<void> => {
        if (!isTauri()) return;
        try {
            const win = await petWindow();
            if (win) await win.hide();
        } catch (err) {
            console.warn('[window] 隐藏宠物窗口失败', err);
        }
    },

    /** 宠物窗口当前是否可见 */
    petWindowVisible: async (): Promise<boolean> => {
        if (!isTauri()) return false;
        try {
            const win = await petWindow();
            return win ? await win.isVisible() : false;
        } catch (err) {
            console.warn('[window] 读取宠物窗口状态失败', err);
            return false;
        }
    },

    /** 宠物窗口是否处于「点击穿透（锁定）」状态 */
    petLocked: (): boolean => storage()?.getItem(PET_LOCKED_KEY) === '1',

    /** 是否允许宠物在屏幕上走动（默认关：会自己挪窗口，得用户点头） */
    petRoam: (): boolean => storage()?.getItem(PET_ROAM_KEY) === '1',

    /** 开关「允许走动」：持久化 + 立刻告诉宿主 */
    setPetRoam: (enabled: boolean): void => {
        try {
            storage()?.setItem(PET_ROAM_KEY, enabled ? '1' : '0');
        } catch {
            /* 存储被禁用：本次生效，重启后不记忆 */
        }
        void import('@tauri-apps/api/event')
            .then(({emit}) => emit(PET_ROAM_EVENT, {enabled}))
            .catch(() => undefined);
    },

    /**
     * 锁定 / 解锁宠物窗口：锁定后鼠标点击**穿透**到下面的窗口，宠物不会被点到。
     *
     * 为什么需要：宠物是 200×160 的矩形窗口，透明区域也会吃鼠标；
     * 桌宠压在别的应用上时，这一点很烦。锁定后它就「只是一张图」。
     * 解锁入口**只在设置页**（锁上之后宠物窗口自己收不到任何点击，这是歌词窗口同款的坑）。
     */
    setPetLocked: async (locked: boolean): Promise<boolean> => {
        try {
            storage()?.setItem(PET_LOCKED_KEY, locked ? '1' : '0');
        } catch {
            /* 存储被禁用：本次生效，重启后不记忆 */
        }
        if (!isTauri()) return locked;
        /* 锁定状态要告诉宿主：宠物窗口的穿透是宿主按「光标在不在精灵上」自动切的，
           手动锁定必须优先，否则会被自动判定覆盖掉。 */
        try {
            const {emit} = await import('@tauri-apps/api/event');
            await emit(PET_LOCK_EVENT, {locked});
            const win = await petWindow();
            if (win) await win.setIgnoreCursorEvents(locked);
        } catch (err) {
            console.warn('[window] 设置宠物窗口点击穿透失败', err);
        }
        return locked;
    },

    /** 记住宠物窗口位置（宠物窗口拖动时自己写；主窗口下次显示时读） */
    rememberPetPosition: (position: {x: number; y: number}): void => {
        try {
            /* 摆放那一刻产生的 onMoved 不算用户拖动（否则位置永远被默认值覆盖） */
            const placed = storage()?.getItem(PLACED_PET_POSITION_KEY);
            if (placed) {
                const at = JSON.parse(placed) as {x?: number; y?: number};
                if (Math.abs((at.x ?? -99999) - position.x) <= 2 && Math.abs((at.y ?? -99999) - position.y) <= 2) {
                    return;
                }
            }
            storage()?.setItem(PET_WINDOW_POSITION_KEY, JSON.stringify(position));
        } catch {
            /* 存储被禁用：位置不记忆，不影响宠物 */
        }
    },

    /** 宠物窗口请求关闭时通知主窗口（主窗口据此把开关关掉） */
    notifyPetWindowClosed: (): void => {
        void import('@tauri-apps/api/event').then(({emit}) => emit(PET_WINDOW_EVENTS.closed));
    },
};

/** 宠物窗口（label 与 `tauri.conf.json` 里的一致） */
export const PET_WINDOW_LABEL = 'pet';

/** 宠物窗口位置（与主窗口同源，localStorage 共享） */
export const PET_WINDOW_POSITION_KEY = 'gently:pet-window-pos';
/** 最近一次「程序摆放」的位置：宠物窗口用它区分「摆放」与「用户拖动」 */
export const PLACED_PET_POSITION_KEY = 'gently:pet-window-placed';

/** 「点击穿透（锁定）」的持久化键（与桌面歌词同款做法） */
export const PET_LOCKED_KEY = 'gently:pet-locked';

/** 主窗口 ↔ 宠物窗口的窗口间事件（不是核心契约事件；名字同样只用 `- / : _`） */
/** 宠物窗口 → 宿主：精灵本体矩形（CSS 像素、窗口内坐标），宿主据此让透明区域点击穿透 */
export const PET_HITBOX_EVENT = 'gently:pet:hitbox';
/** 主窗口 → 宿主：宠物窗口的锁定（点击穿透）状态 */
export const PET_LOCK_EVENT = 'gently:pet:lock';
/** 宿主 → 宠物窗口：正在往哪边走（-1 左 / 0 停 / 1 右） */
export const PET_WALK_EVENT = 'gently:pet:walk';
/** 主窗口 → 宿主：是否允许在屏幕上走动 */
export const PET_ROAM_EVENT = 'gently:pet:roam';
/** 「允许走动」的持久化键 */
export const PET_ROAM_KEY = 'gently:pet-roam';

/** 宿主 → 宠物窗口：该看向哪个方向（0..16，0 = 正上、顺时针）；非 Windows 平台不会发 */
export const PET_LOOK_EVENT = 'gently:pet:look';

/** 前端 → 宿主：正在拖动宠物窗口（拖的时候宿主不切点击穿透、也不自己走动） */
export const PET_DRAGGING_EVENT = 'gently:pet:dragging';

export const PET_WINDOW_EVENTS = {
    /** 主窗口 → 宠物窗口：只读播放快照 + 宠物 revision */
    update: 'gently:pet:update',
    /** 宠物窗口 → 主窗口：我起来了，把当前快照发我一份 */
    ready: 'gently:pet:ready',
    /** 宠物窗口 → 主窗口：用户把它关了 */
    closed: 'gently:pet:closed',
} as const;

async function petWindow() {
    const {WebviewWindow} = await import('@tauri-apps/api/webviewWindow');
    return WebviewWindow.getByLabel(PET_WINDOW_LABEL);
}

type PetWin = NonNullable<Awaited<ReturnType<typeof petWindow>>>;

/** 摆放宠物窗口：用户拖动过就尊重，否则主屏右下角（判断在纯函数里） */
async function placePetWindow(win: PetWin): Promise<void> {
    try {
        const {availableMonitors, PhysicalPosition} = await import('@tauri-apps/api/window');
        const [monitors, size] = await Promise.all([availableMonitors(), win.outerSize()]);
        const rects = monitors.map((monitor) => ({
            x: monitor.position.x,
            y: monitor.position.y,
            width: monitor.size.width,
            height: monitor.size.height,
        }));
        const position = placePet(readPetPosition(), rects, size);
        await win.setPosition(new PhysicalPosition(position.x, position.y));
        /* 记下「这次是程序摆的」：宠物窗口收到 onMoved 时，如果位置正好等于它，
           说明只是摆放（不是用户拖动），不该覆盖用户记住的位置——
           否则每次启动都会被「创建时的默认位置」污染（曾经出现的怪现象：
           宠物出现在主窗口旁边而不是右下角）。 */
        try {
            storage()?.setItem(PLACED_PET_POSITION_KEY, JSON.stringify(position));
        } catch {
            /* 存储被禁用：不记也没关系 */
        }
    } catch (err) {
        console.warn('[window] 摆放宠物窗口失败（保持默认位置）', err);
    }
}

/** 读用户上次拖动后的位置（读不出来就 `null`：交给默认摆放） */
export function readPetPosition(): {x: number; y: number} | null {
    try {
        const raw = storage()?.getItem(PET_WINDOW_POSITION_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const {x, y} = parsed as {x?: unknown; y?: unknown};
        if (typeof x !== 'number' || typeof y !== 'number') return null;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {x, y};
    } catch {
        return null;
    }
}

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










