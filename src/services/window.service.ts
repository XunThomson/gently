/**
 * 桌面窗口能力封装。
 *
 * 浏览器 / `vite dev` 环境下所有方法都是安全的空操作，
 * 只有在 Tauri 宿主里才会真正调用原生窗口 API（动态导入，避免无谓的体积）。
 */

export const isTauri = (): boolean =>
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

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
    setAlwaysOnTop: (value: boolean) => run((w) => w.setAlwaysOnTop(value)),
    /** 悬浮小窗：置顶 + 缩小尺寸 */
    setCompact: (value: boolean) =>
        run(async (w) => {
            await w.setAlwaysOnTop(value);
            await w.setSize(
                value
                    ? new (await import('@tauri-apps/api/window')).LogicalSize(420, 320)
                    : new (await import('@tauri-apps/api/window')).LogicalSize(1180, 760),
            );
        }),
};
