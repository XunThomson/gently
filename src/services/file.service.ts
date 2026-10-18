import {isTauri} from './window.service';

/**
 * 文件系统 / 系统集成能力封装。
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

    /**
     * 用系统默认程序打开一个外部地址（第三方授权页走这里）。
     *
     * 返回**是否真的打开了**：调用方（授权流程）需要据此决定要不要取消等待——
     * 假装成功会让回调监听白等到超时。浏览器预览下返回 `false`（没有宿主能力）。
     */
    async openExternal(url: string): Promise<boolean> {
        if (!isTauri()) return false;
        try {
            const {openUrl} = await import('@tauri-apps/plugin-opener');
            await openUrl(url);
            return true;
        } catch (err) {
            console.warn('[file] 打开外部地址失败', err);
            return false;
        }
    },
};
