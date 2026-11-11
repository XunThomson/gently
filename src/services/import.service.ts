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
 * 一次导入的进度快照（R136）。
 *
 * `active` 为 false 表示当前没有导入在进行；`bytesTotal` 为 0 表示上游没给大小
 * （界面按「未知总量」显示，不编一个百分比）。
 */
export interface ImportProgress {
    active: boolean;
    fileName: string;
    /** 第几个文件（从 1 开始；0 = 还没开始） */
    fileIndex: number;
    /** 这次一共选了几个文件 */
    fileCount: number;
    bytesDone: number;
    bytesTotal: number;
    imported: number;
    failed: number;
    skipped: number;
}

/**
 * 问宿主「导入到哪了」。
 *
 * 返回 `null` = 没有宿主（浏览器 / 桌面端）：界面据此保持原来的「导入中…」，
 * 不显示一条永远 0% 的假进度。
 */
export async function importProgress(): Promise<ImportProgress | null> {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
    try {
        const {invoke} = await import('@tauri-apps/api/core');
        const snapshot = await invoke<ImportProgress>('import_progress');
        return {
            active: Boolean(snapshot.active),
            fileName: String(snapshot.fileName ?? ''),
            fileIndex: Number(snapshot.fileIndex ?? 0),
            fileCount: Number(snapshot.fileCount ?? 0),
            bytesDone: Number(snapshot.bytesDone ?? 0),
            bytesTotal: Number(snapshot.bytesTotal ?? 0),
            imported: Number(snapshot.imported ?? 0),
            failed: Number(snapshot.failed ?? 0),
            skipped: Number(snapshot.skipped ?? 0),
        };
    } catch (err) {
        // 读不到进度不该打断导入：调用方按「没有进度」处理
        console.warn('[import] 读取导入进度失败', err);
        return null;
    }
}

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
async function invokeImport(
    command: 'import_audio' | 'import_audio_dir',
): Promise<ImportAudioResult> {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return EMPTY;

    try {
        const {invoke} = await import('@tauri-apps/api/core');
        const result = await invoke<{
            imported: number;
            failed: number;
            skipped?: number;
            cancelled: boolean;
            dir: string;
        }>(command);
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

/** 选文件导入（单个 / 多选）。 */
export function importAudioFiles(): Promise<ImportAudioResult> {
    return invokeImport('import_audio');
}

/**
 * 选**目录**并递归导入音频（R139）。
 *
 * 文件多时（一张专辑、一个下载目录）让用户一个个勾选不现实；原生递归扫描后
 * 走与「多选文件」完全相同的拷贝/进度流程。
 */
export function importAudioDirectory(): Promise<ImportAudioResult> {
    return invokeImport('import_audio_dir');
}
