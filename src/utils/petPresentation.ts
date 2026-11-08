import {PET_HUD_GAP, PET_HUD_RESERVE, type Point, type Rect} from './petWindowPosition';

export const PET_SIZES = ['small', 'medium', 'large'] as const;
export type PetSize = (typeof PET_SIZES)[number];
export const DEFAULT_PET_SIZE: PetSize = 'medium';
export const PET_DISPLAY_HEIGHT: Record<PetSize, number> = {
    small: 104,
    medium: 208,
    large: 312,
};

export function parsePetSize(value: string | null | undefined): PetSize {
    return PET_SIZES.includes(value as PetSize) ? (value as PetSize) : DEFAULT_PET_SIZE;
}

export function nextPetSize(size: PetSize): PetSize {
    return PET_SIZES[(PET_SIZES.indexOf(size) + 1) % PET_SIZES.length];
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
