/**
 * 「从手机导入」的结果文案（纯函数，冒烟直接钉）。
 *
 * 为什么单独抽出来：结果有五种情形（打不开选择器 / 取消 / 一个都不是音频 /
 * 读到了但都失败 / 部分成功 + 跳过的非音频），散在组件里既难测也容易说漏。
 * 尤其是**跳过**：选择器放开 MIME 之后（R118，`audio/*` 会把 `.m4s` 灰掉），
 * 用户完全可能选到图片或文档，静默丢掉会让人以为「导入坏了」。
 */

/** 与 `services/import.service.ts::ImportAudioResult` 结构一致（只取文案需要的字段） */
export interface ImportSummary {
    imported: number;
    failed: number;
    skipped: number;
    cancelled: boolean;
    error?: string;
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

export function importNoteText(result: ImportSummary, t: Translate): string {
    if (result.error) return t('page.local.importFailed');
    if (result.cancelled) return '';
    if (result.imported === 0) {
        return result.skipped > 0
            ? t('page.local.importSkippedOnly', {count: result.skipped})
            : t('page.local.importEmpty');
    }

    const base =
        result.failed > 0
            ? t('page.local.importedPartial', {imported: result.imported, failed: result.failed})
            : t('page.local.imported', {count: result.imported});
    if (result.skipped === 0) return base;
    return `${base} · ${t('page.local.importSkipped', {count: result.skipped})}`;
}

/**
 * 「正在导入到哪了」的一句话（纯函数，冒烟直接钉；R136）。
 *
 * 两种形态必须分开：读到文件大小时给百分比（拷一个 200 MB 的文件才看得出在动），
 * 读不到大小就只说「第几个 / 共几个 + 文件名」——**不编一个 0% 挂着**。
 */
export function importProgressText(
    progress: {
        fileIndex: number;
        fileCount: number;
        fileName: string;
        bytesDone: number;
        bytesTotal: number;
    },
    t: Translate,
): string {
    const total = progress.fileCount > 0 ? progress.fileCount : 1;
    const index = Math.min(Math.max(progress.fileIndex, 1), total);
    const name = progress.fileName || '';
    const percent =
        progress.bytesTotal > 0
            ? Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100))
            : undefined;
    return percent === undefined
        ? t('page.local.importProgress', {index, count: total, name})
        : t('page.local.importProgressPercent', {index, count: total, name, percent});
}

/**
 * 挑出「导入进来的副本」：路径落在导入目录里的本地曲目（纯函数，冒烟直接钉）。
 * 为什么要挑：导入是**拷一份**（原文件删掉不影响曲库），反面是占双份空间。
 * 用户清理时只能删这些副本——他自己扫描进来的音乐在别的目录里，动它才是危险的。
 * `dir` 为空（桌面端 / 还没拿到目录）时返回空数组：**没有目录就不敢删任何东西**。
 */
export function importedTracksOf<T extends {path: string}>(tracks: T[], dir: string | null): T[] {
    if (!dir) return [];
    const root = dir.endsWith('/') ? dir : `${dir}/`;
    const normalizedRoot = root.replace(/\\/g, '/');
    return tracks.filter((track) => track.path.replace(/\\/g, '/').startsWith(normalizedRoot));
}
