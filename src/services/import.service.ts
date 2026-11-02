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
    /** 选进来但不是音频、被跳过的文件数（R118：选择器放开 MIME 后必须如实回报） */
    skipped: number;
    /** 用户点了取消 */
    cancelled: boolean;
    /** 落点目录；前端拿它去扫描。取消或失败时为 null */
    dir: string | null;
    /** 失败原因（打不开选择器等）；成功时没有 */
    error?: string;
}

const EMPTY: ImportAudioResult = {
    imported: 0,
    failed: 0,
    skipped: 0,
    cancelled: true,
    dir: null,
};

/**
 * 导入副本的落点目录（`<filesDir>/music`），**一次安装内不变**，所以缓存。
 *
 * 只有原生知道这个绝对路径（`filesDir` 随包名/用户变化）；界面用它做两件事：
 * 判断「哪些本地曲目是导入进来的副本」、显示「清理」入口。桌面端返回 `null`。
 */
let cachedImportDir: string | null | undefined;

export async function importedMusicDir(): Promise<string | null> {
    if (cachedImportDir !== undefined) return cachedImportDir;
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
        cachedImportDir = null;
        return null;
    }
    try {
        const {invoke} = await import('@tauri-apps/api/core');
        const dir = await invoke<string>('imported_dir');
        cachedImportDir = dir ? dir : null;
    } catch (err) {
        // 读不到就当没有（不缓存失败：下次打开面板还可以再试）
        console.warn('[import] 读取导入目录失败', err);
        return null;
    }
    return cachedImportDir;
}

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
            skipped?: number;
            cancelled: boolean;
            dir: string;
        }>('import_audio');
        return {
            imported: Number(result.imported ?? 0),
            failed: Number(result.failed ?? 0),
            skipped: Number(result.skipped ?? 0),
            cancelled: Boolean(result.cancelled),
            dir: result.dir ? result.dir : null,
        };
    } catch (err) {
        // 如实把原因带出去（界面按 i18n 文案显示，不显示开发者字符串）
        return {...EMPTY, error: err instanceof Error ? err.message : String(err)};
    }
}
