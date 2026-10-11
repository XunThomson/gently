/**
 * 皮肤（主题）域的**本机核心**门面。
 *
 * 皮肤校验（结构 + **令牌键名白名单**）只在核心实现一份（`core/src/skin.rs`，见契约 §7），
 * 前端浏览器预览用 `src/theme/presets.ts` 的宽松解析兜底——桌面端一律以核心为准，
 * 因为「哪些键名可以覆盖主题 token」这件事必须以主题配置为准，不能被绕过。
 *
 * 读失败/无核心 → `null`（调用方退回内置预设）；写返回 `CoreResult`，让界面能显示
 * `skin.invalid_document` / `skin.token_rejected` 的具体原因与键名。
 */

import type {CoreResult, ImportSource} from '../api';
import type {ThemeSkin} from '../theme';
import {coreAvailable, invokeCore} from './core.bridge';

async function read<T>(command: string, params: Record<string, unknown> = {}): Promise<T | null> {
    if (!coreAvailable()) return null;
    const result = await invokeCore<T>(command, params);
    return result.ok ? result.data : null;
}

/**
 * 已安装的**用户皮肤**（不含内置预设：内置的不占用户的存储，也不可删除）。
 * 每项带 `active`（激活状态存在核心的 meta 里，不是皮肤自身的属性）。
 */
export function coreSkins(): Promise<(ThemeSkin & {active?: boolean})[] | null> {
    return read<(ThemeSkin & {active?: boolean})[]>('skin.list');
}

/** 安装前校验：结构 + 令牌键名；被拒键名由核心在错误详情里列出（不落盘）。 */
export function coreSkinPreview(
    from: ImportSource,
): Promise<CoreResult<{skin: ThemeSkin; warnings: string[]}>> {
    return invokeCore<{skin: ThemeSkin; warnings: string[]}>('skin.preview', {from});
}

export function coreSkinInstall(from: ImportSource): Promise<CoreResult<ThemeSkin>> {
    return invokeCore<ThemeSkin>('skin.install', {from});
}

export function coreSkinRemove(id: string): Promise<CoreResult<null>> {
    return invokeCore<null>('skin.remove', {id});
}

/** `null` = 恢复默认主题（不是「删除」，所以单独一条命令）。 */
export function coreSkinSetActive(id: string | null): Promise<CoreResult<null>> {
    return invokeCore<null>('skin.setActive', {id});
}

/** 导出即分享：`json` 直接返回文本，`file` 写入用户在系统对话框里选的位置。 */
export function coreSkinExport(
    id: string,
    format: 'json' | 'file' = 'json',
): Promise<CoreResult<{json?: string; path?: string}>> {
    return invokeCore<{json?: string; path?: string}>('skin.export', {id, format});
}
