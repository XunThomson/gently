import type {CoreErrorCode} from '../api';
import {getThemeSkin, parseSkin, serializeSkin} from '../theme';
import type {ThemeSkin} from '../theme';
import {coreAvailable} from './core.bridge';
import {coreSkins, coreSkinExport, coreSkinInstall, coreSkinPreview, coreSkinRemove, coreSkinSetActive} from './core.skin';

/**
 * 皮肤门面（主题市场的数据来源）。
 *
 * **桌面端以本机核心为准**：皮肤的校验（结构 + 令牌键名白名单）与存放在
 * `core/src/skin.rs`，导入走 `skin.preview`（只校验）+ `skin.install`（落盘），
 * 激活状态存在核心的 meta 里（`skin.setActive`），导出走 `skin.export`。
 *
 * **浏览器预览**（`pnpm dev` 无 Tauri）没有核心，退回 `src/theme/presets.ts` 的本地解析 +
 * store 里的持久化——那只是让预览可用，不是第二份「权威校验」：真机上永远以核心为准。
 * 因此这里刻意把两边的**接口形状**做成一致（`SkinImportOutcome`），视图不需要分支。
 */

export interface SkinImportOutcome {
    ok: boolean;
    skin?: ThemeSkin;
    /** 非致命提示（核心给的：例如 `builtin` 字段被忽略） */
    warnings: string[];
    /** 失败说明（核心 message；浏览器端为本地解析原因） */
    reason?: string;
    /** 被拒的令牌键名：`skin.token_rejected` 时逐条列出，界面要能说清「哪里不允许」 */
    rejectedKeys?: string[];
    code?: CoreErrorCode;
}

/** 从错误信封里取出被拒键名（核心放在 `details.rejected`）。 */
function rejectedKeysOf(details: unknown): string[] | undefined {
    if (!details || typeof details !== 'object') return undefined;
    const value = (details as {rejected?: unknown}).rejected;
    return Array.isArray(value) ? value.map(String) : undefined;
}

/**
 * 核心回来的皮肤文档 → 界面可直接渲染的皮肤。
 *
 * 核心只校验**令牌**（颜色/尺寸/圆角…的键名与类型），`swatches` / `description` / `author`
 * 这类展示字段它不管。缺了 `swatches` 的皮肤（合法文档）会让主题市场在
 * `item.swatches.map(...)` 上抛错、整页变成错误边界（R68 真机实测踩到）。
 * 所以「补齐界面依赖的字段」收在这一个地方，`load` / 两种导入路径都过它。
 */
function toThemeSkin(skin: ThemeSkin): ThemeSkin {
    return {
        ...skin,
        description: skin.description ?? '',
        author: skin.author ?? 'imported',
        swatches: Array.isArray(skin.swatches) ? skin.swatches : [],
        builtin: false,
    };
}

export const skinService = {
    /** 已安装的**用户皮肤**（桌面端来自核心；浏览器返回 `null` → 用本地持久化的那份）。 */
    async load(): Promise<ThemeSkin[] | null> {
        const skins = await coreSkins();
        return skins ? skins.map(toThemeSkin) : null;
    },

    /**
     * 导入皮肤文本（文件或粘贴）。桌面端：先 `skin.preview` 校验拿到警告，
     * 再 `skin.install` 落盘；失败时把核心的拒绝键名原样带出来。
     */
    async importFromText(content: string): Promise<SkinImportOutcome> {
        if (coreAvailable()) {
            const preview = await coreSkinPreview({kind: 'paste', content});
            if (!preview.ok) {
                return {
                    ok: false,
                    warnings: [],
                    reason: preview.error.message,
                    rejectedKeys: rejectedKeysOf(preview.error.details),
                    code: preview.error.code,
                };
            }

            const installed = await coreSkinInstall({kind: 'paste', content});
            if (!installed.ok || !installed.data) {
                return {
                    ok: false,
                    warnings: preview.data?.warnings ?? [],
                    reason: installed.ok ? '核心未返回皮肤' : installed.error.message,
                    code: installed.ok ? undefined : installed.error.code,
                };
            }

            return {ok: true, skin: toThemeSkin(installed.data), warnings: preview.data?.warnings ?? []};
        }

        // 浏览器预览：本地解析（宽松版，只保证形状可用）
        const parsed = parseSkin(content);
        if (parsed.ok && parsed.skin) return {ok: true, skin: parsed.skin, warnings: []};
        return {ok: false, warnings: [], reason: parsed.reason};
    },

    /**
     * 从**本机路径**导入皮肤（`{kind:'file'}`）。
     *
     * 与 `importFromText` 是同一套流程（`skin.preview` 校验 → `skin.install` 落盘），
     * 区别只在来源形状：路径由核心去读，前端不碰文件系统。
     * 为什么需要它：桌面端没有 Tauri 的 dialog 插件，`<input type=file>` 那扇原生选择器
     * 在某些环境下不好用（R49 实测：合成输入驱动不了它的按钮）；粘贴路径是与插件页一致的、
     * 一定走得通的那条路。
     */
    async importFromPath(path: string): Promise<SkinImportOutcome> {
        if (!coreAvailable()) {
            // 浏览器预览读不了本地路径（没有文件系统权限），如实说明而不是假装成功
            return {ok: false, warnings: [], reason: '浏览器预览不支持按路径导入，请粘贴 JSON'};
        }
        const preview = await coreSkinPreview({kind: 'file', path});
        if (!preview.ok) {
            return {
                ok: false,
                warnings: [],
                reason: preview.error.message,
                rejectedKeys: rejectedKeysOf(preview.error.details),
                code: preview.error.code,
            };
        }
        const installed = await coreSkinInstall({kind: 'file', path});
        if (!installed.ok || !installed.data) {
            return {
                ok: false,
                warnings: preview.data?.warnings ?? [],
                reason: installed.ok ? '核心未返回皮肤' : installed.error.message,
                code: installed.ok ? undefined : installed.error.code,
            };
        }
        return {ok: true, skin: toThemeSkin(installed.data), warnings: preview.data?.warnings ?? []};
    },

    /** 删除用户皮肤（内置预设不可删，视图已经挡掉）。 */
    async remove(id: string): Promise<void> {
        await coreSkinRemove(id);
    },

    /** 激活皮肤；`null` = 恢复默认主题。 */
    async setActive(id: string | null): Promise<void> {
        await coreSkinSetActive(id);
    },

    /** 导出为可分享的 JSON 文本；桌面端优先用核心给的（它就是落盘的那份原文）。 */
    async exportSkin(skin: ThemeSkin): Promise<string> {
        /**
         * **内置预设不问核心**：核心只认识用户导入的皮肤（`skin.list` 里没有内置预设），
         * 拿 `ocean` 这类内置 id 去问，只会换来一条 `common.not_found 皮肤未安装：ocean`
         * 的误导性告警（R43 在打包版日志里看到），再退回本地序列化——白跑一趟还没什么好处。
         * 与「本地曲目不问核心要歌词」「演示源不问核心」是同一类收口。
         */
        if (skin.builtin !== false) {
            return serializeSkin(getThemeSkin(skin.id, [skin]));
        }
        const viaCore = await coreSkinExport(skin.id, 'json');
        if (viaCore.ok && viaCore.data?.json) return viaCore.data.json;
        return serializeSkin(getThemeSkin(skin.id, [skin]));
    },

    /**
     * 把用户皮肤**写到磁盘**并返回路径（`skin.export{format:'file'}` → `<data>/skins/<id>.json`）。
     *
     * 为什么导出要走核心落盘：桌面宿主没有浏览器那套下载处理器，`<a download>` 点了没反应
     * （R68 用户报的「导出按钮没反应」就是这条）。核心本来就有 `file` 格式，直接用它写文件、
     * 再用 `system.reveal` 在资源管理器里选中，用户能立刻拿到文件。
     *
     * 内置预设没有落盘文件（`skin.list` 只含用户皮肤），返回 `null` 由调用方退回「复制 JSON」。
     */
    async exportToFile(id: string): Promise<string | null> {
        if (!coreAvailable()) return null;
        const viaCore = await coreSkinExport(id, 'file');
        return viaCore.ok && viaCore.data?.path ? viaCore.data.path : null;
    },
};
