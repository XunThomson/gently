import type {BackgroundKind, BackgroundOptions} from './backgroundSettings';
import {normalizeBackgroundOptions} from './backgroundSettings';

/**
 * **主题包**（R87）：一份皮肤 JSON + 可选的背景素材。
 *
 * 背景本来就是「皮肤的一部分」——以前它被放在皮肤之外（设置页单独导入视频/网页、单独调透明度），
 * 于是用户导入一套主题之后还得自己再配一遍背景，这显然不合理。现在：
 *
 * - 皮肤 JSON 里可以带一个 `background` 块：`{kind: "video"|"web", file?, options?}`；
 * - 导入时如果同时选了背景文件（同一个「主题包」目录里的 `bg.mp4` / `bg.html`），
 *   前端把它存进 IndexedDB，并**按皮肤 id 绑定**（`skin:<id>`），切到这套主题就自动生效；
 * - 设置页里的背景参数仍然保留，作为**补充手段**给用户微调（皮肤给的只是默认值）。
 *
 * 这个模块只做**纯逻辑**（形状校验、文件挑选、参数合并），不碰 IndexedDB / store。
 */
export interface SkinBackgroundHint {
    kind: BackgroundKind;
    /** 主题包内的背景文件名（纯文件名，不带路径） */
    file?: string;
    /** 皮肤给出的默认展示参数（只覆盖它写了的项；`null` = 跟随主题），用户仍可在设置页微调 */
    options?: Partial<BackgroundOptions>;
}

/** 背景素材文件的扩展名（视频与单文件网页；与设置页导入接受的范围一致） */
export const SKIN_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.m4v', '.ogg'] as const;
export const SKIN_WEB_EXTENSIONS = ['.html', '.htm'] as const;

/** 皮肤 JSON 的扩展名 */
export const SKIN_JSON_EXTENSIONS = ['.json'] as const;

function extensionOf(name: string): string {
    const at = name.lastIndexOf('.');
    return at < 0 ? '' : name.slice(at).toLowerCase();
}

export function isSkinJsonFile(name: string): boolean {
    return (SKIN_JSON_EXTENSIONS as readonly string[]).includes(extensionOf(name));
}

/** 背景文件的类型（不是背景文件返回 null） */
export function backgroundKindOfFile(name: string): BackgroundKind | null {
    const ext = extensionOf(name);
    if ((SKIN_VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return 'video';
    if ((SKIN_WEB_EXTENSIONS as readonly string[]).includes(ext)) return 'web';
    return null;
}

/** 背景素材在 IndexedDB 里的固定 id：一套皮肤一份，换背景就覆盖它 */
export function skinBackgroundAssetId(skinId: string): string {
    return `skin:${skinId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 读出皮肤 JSON 里的背景声明；没有/非法一律当「这套主题不带背景」。
 *
 * 非法不报错是刻意的：核心已经校验过一遍（形状不对的皮肤根本装不上），
 * 而浏览器预览里也没有核心把关——宁可「这套主题没有背景」，也不要让导入整体失败。
 */
export function readSkinBackgroundHint(raw: unknown): SkinBackgroundHint | null {
    if (!isRecord(raw)) return null;
    const kind = raw.kind === 'web' ? 'web' : raw.kind === 'video' ? 'video' : null;
    if (!kind) return null;

    const file = typeof raw.file === 'string' ? raw.file.trim() : '';
    // 只接受纯文件名：带路径的声明一律忽略（前端不该因为一份 JSON 去读任意路径）
    const safeFile = file && !file.includes('/') && !file.includes('\\') && !file.includes('..') ? file : '';

    const hint: SkinBackgroundHint = {kind};
    if (safeFile) hint.file = safeFile;
    if (isRecord(raw.options)) {
        /* **保留作者写了的键，不在这里补默认值**：补了默认值就分不清「作者要 cover」
           与「作者没写」，合并时会把用户微调过的 fit/playbackRate 一起盖掉。
           值本身照旧不信任，最终由 `mergeSkinBackgroundOptions` 归一化。 */
        hint.options = {...(raw.options as Partial<BackgroundOptions>)};
    }
    return hint;
}

/**
 * 从用户选中的一堆文件里挑出「主题包」：一个 JSON + 一个背景素材。
 *
 * 支持两种用法：多选（`multiple`）与整目录（`webkitdirectory`）。挑不出来时返回
 * 明确的原因，而不是让调用方自己猜——用户选错文件是最常见的一步。
 */
export function pickSkinPackageFiles(
    names: readonly string[],
): {json?: string; background?: string; reason?: 'no-json' | 'ambiguous-json'} {
    // 只取纯文件名（`webkitdirectory` 会给相对路径 `dir/skin.json`）
    const base = names.map((name) => name.split(/[/\\]/).pop() ?? name);
    const jsonFiles = base.filter(isSkinJsonFile);
    if (jsonFiles.length === 0) return {reason: 'no-json'};
    if (jsonFiles.length > 1) {
        // 优先叫 skin.json / theme.json 的那个；否则交给调用方提示「请只选一个 JSON」
        const preferred = jsonFiles.find((name) => /^(skin|theme|gently)\.json$/i.test(name));
        if (!preferred) return {reason: 'ambiguous-json'};
        return {json: preferred, background: base.find((name) => backgroundKindOfFile(name) !== null)};
    }
    return {json: jsonFiles[0], background: base.find((name) => backgroundKindOfFile(name) !== null)};
}

/**
 * 合并「皮肤给的默认参数」与「用户当前参数」。
 *
 * 皮肤的 `null` 表示「跟随主题」（与设置页同一语义），因此这里只覆盖皮肤**显式给了值**的项，
 * 其余沿用用户当前值——切主题不该把用户调的透明度一起抹掉。
 */
export function mergeSkinBackgroundOptions(
    hint: SkinBackgroundHint | null,
    current: BackgroundOptions,
): BackgroundOptions {
    const next: BackgroundOptions = {...current};
    if (!hint?.options) return next;
    for (const [key, value] of Object.entries(hint.options)) {
        // 只覆盖皮肤**显式写了**的项；`null` 在设置页的语义是「跟随主题」，这里同样不覆盖
        if (value === undefined || value === null) continue;
        (next as unknown as Record<string, unknown>)[key] = value;
    }
    return normalizeBackgroundOptions(next);
}
