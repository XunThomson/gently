/**
 * 从手机导入音频（P3 · R114）。
 *
 * 安卓上普通用户拿不到 `/storage/emulated/0/...` 这种绝对路径，所以「粘贴目录再扫描」
 * 这条路只对开发者成立。这里走 **SAF**（系统文件选择器）：用户选几个音频文件，
 * Kotlin 侧把它们拷进应用私有目录，再由本模块把目录交给核心扫描入库。
 *
 * 分工（谁负责什么）：
 * - 原生：选文件、拷文件、给回目录（`import_audio`，仅手机宿主有）；
 * - 核心：目录 → 库（`library.local.scan`，桌面端同一条路）；
 * - 界面：按钮 + 结果提示，不直接 `invoke`。
 */

export interface ImportAudioResult {
    /** 成功拷进应用目录的文件数 */
    imported: number;
    /** 拷失败的文件数（单个失败不影响其它） */
    failed: number;
    /** 用户点了取消 */
    cancelled: boolean;
    /** 落点目录；前端拿它去扫描。取消或失败时为 null */
    dir: string | null;
    /** 失败原因（打不开选择器等）；成功时没有 */
    error?: string;
}

const EMPTY: ImportAudioResult = {imported: 0, failed: 0, cancelled: true, dir: null};

/**
 * 打开系统文件选择器导入音频。
 *
 * 浏览器 / 桌面端：直接返回空结果（`cancelled: true`）——桌面端用「填目录 + 扫描」，
 * 没必要为了统一而编一条假成功。
 */
export async function importAudioFiles(): Promise<ImportAudioResult> {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return EMPTY;

    try {
        const {invoke} = await import('@tauri-apps/api/core');
        const result = await invoke<{
            imported: number;
            failed: number;
            cancelled: boolean;
            dir: string;
        }>('import_audio');
        return {
            imported: Number(result.imported ?? 0),
            failed: Number(result.failed ?? 0),
            cancelled: Boolean(result.cancelled),
            dir: result.dir ? result.dir : null,
        };
    } catch (err) {
        // 如实把原因带出去（界面按 i18n 文案显示，不显示开发者字符串）
        return {...EMPTY, error: err instanceof Error ? err.message : String(err)};
    }
}
