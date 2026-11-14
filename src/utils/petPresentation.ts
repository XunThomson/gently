import {PET_HUD_GAP, PET_HUD_RESERVE, type Point, type Rect} from './petWindowPosition';

/**
 * 宠物尺寸：**显示高度（CSS 像素）**，用户可在 min–max 之间自由调整。
 *
 * 以前只有 small / medium / large 三档，等于替用户决定「你只能用这三个尺寸」；
 * 现在存的是连续数值，滑杆、数字输入与三档快捷键都写进同一份持久化。
 * 旧存档里的字符串（`small` / `medium` / `large`）仍能读：映射到对应的默认高度。
 */
export type PetSize = number;

export const PET_SIZE_MIN = 64;
export const PET_SIZE_MAX = 480;

/** 三档快捷值（不是限制，只是常用尺寸） */
export const PET_SIZE_PRESETS = [104, 208, 312] as const;

/** 旧档位 → 显示高度（兼容 R141 之前存下的字符串） */
export const PET_DISPLAY_HEIGHT = {
    small: 104,
    medium: 208,
    large: 312,
} as const;

export const DEFAULT_PET_SIZE: PetSize = PET_DISPLAY_HEIGHT.medium;

/** 把任意输入钳成合法尺寸（整数像素）；坏值回默认档 */
export function clampPetSize(value: number): PetSize {
    if (!Number.isFinite(value)) return DEFAULT_PET_SIZE;
    return Math.min(PET_SIZE_MAX, Math.max(PET_SIZE_MIN, Math.round(value)));
}

/** 读持久化 / 事件里的尺寸：认数字、数字字符串与旧的三档字符串 */
export function parsePetSize(value: string | number | null | undefined): PetSize {
    if (typeof value === 'number') return clampPetSize(value);
    if (typeof value !== 'string') return DEFAULT_PET_SIZE;
    const text = value.trim();
    if (!text) return DEFAULT_PET_SIZE;
    const legacy = PET_DISPLAY_HEIGHT[text as keyof typeof PET_DISPLAY_HEIGHT];
    if (legacy !== undefined) return legacy;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? clampPetSize(parsed) : DEFAULT_PET_SIZE;
}

/** 在三档快捷值之间循环（设置页 / 菜单的「下一档」入口） */
export function nextPetSize(size: PetSize): PetSize {
    const current = parsePetSize(size);
    const index = PET_SIZE_PRESETS.indexOf(current as (typeof PET_SIZE_PRESETS)[number]);
    if (index < 0) {
        const next = PET_SIZE_PRESETS.find((preset) => preset > current);
        return next ?? PET_SIZE_PRESETS[0];
    }
    return PET_SIZE_PRESETS[(index + 1) % PET_SIZE_PRESETS.length];
}

/**
 * 窗口尺寸：本体 + 四边各一份 HUD 槽位。
 *
 * 窗口是**以本体为中心**的对称画布，HUD 在上/下/左/右都放得下；
 * 本体在窗口里的位置因此是常量，贴边时窗口可以越出屏幕，不影响本体到达边缘。
 */
export function petWindowDimensions(content: {width: number; height: number}): {width: number; height: number} {
    const pad = PET_HUD_RESERVE + PET_HUD_GAP;
    return {
        width: Math.ceil(content.width) + pad * 2,
        height: Math.ceil(content.height) + pad * 2,
    };
}

export function petMonitorRects(monitors: {position: Point; size: {width: number; height: number}}[]): Rect[] {
    return monitors.map((monitor) => ({
        x: monitor.position.x,
        y: monitor.position.y,
        width: monitor.size.width,
        height: monitor.size.height,
    }));
}
