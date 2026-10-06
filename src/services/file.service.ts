import {isTauri} from './window.service';

/**
 * 文件系统能力封装。
 * 浏览器 / `vite dev` 下为安全空操作，仅在 Tauri 宿主内调用原生能力。
 */
export const fileService = {
    /** 在系统文件管理器中定位文件 */
    async revealInDir(path: string): Promise<void> {
        if (!isTauri()) return;
        try {
            const {revealItemInDir} = await import('@tauri-apps/plugin-opener');
            await revealItemInDir(path);
        } catch (err) {
            console.warn('[file] 定位文件失败', err);
        }
    },
};
