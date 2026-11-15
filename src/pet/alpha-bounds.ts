/**
 * 图集「不透明像素」的包围盒（**纯函数**，只有扫描像素 + 坐标换算）。
 *
 * 为什么需要：宠物的可交互区域原来取**整个图集格子**（`body` 盒子），
 * 而像素角色只占格子的一部分——鼠标还没碰到角色就会被判定成「在宠物身上」，
 * 透明像素多的帧尤其明显（角色只占 60% 左右）。
 *
 * 做法：解码图集时把整张图降采样一次，逐帧扫 alpha，把每帧角色的包围盒记下来；
 * 命中判定只把「当前动画所有帧的包围盒并集」换算到窗口坐标上报。
 *
 * 抽成纯函数的原因：包围盒 → 盒内坐标 → 窗口坐标这条链一旦算错，
 * 表现是「鼠标要偏一段距离才能点中」，在界面上没法调试；这里可以喂合成像素断言。
 */

import {frameBox, frameCell, lookBox, type AtlasPlan, type FrameBox} from './frame-layout';

/** 像素坐标矩形（宽高为正） */
export interface PixelRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** 降采样后的图集像素（`scale` = 采样图 / 原图） */
export interface AlphaSample {
    data: Uint8ClampedArray | number[];
    width: number;
    height: number;
    scale: number;
}

/** 每个动画、每一帧的不透明包围盒（原图像素坐标；整格全透明时为 null） */
export type FrameAlphaBounds = (PixelRect | null)[][];

export interface AlphaBounds {
    frames: FrameAlphaBounds;
    /** 16 个 look 方向的包围盒（没有 lookRows 时为 null） */
    look: (PixelRect | null)[] | null;
}

/** alpha 超过这个值才算「角色像素」：降采样后边缘会变成半透明，取低阈值宁可多算一点 */
export const ALPHA_HIT_THRESHOLD = 8;

/** 命中矩形在真实包围盒外再放宽的 CSS 像素：像素画的边缘 + 上下浮动（BOB_PX）留余量 */
export const HIT_PADDING = 4;

/** 空包围盒 */
export const EMPTY_ALPHA_BOUNDS: AlphaBounds = {frames: [], look: null};

function clampNumber(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * 在一张 RGBA 图里扫一个矩形区域，返回 alpha > `threshold` 的像素包围盒。
 *
 * @param data RGBA 像素（长度至少 width×height×4）
 * @param rect 要扫的区域（像素坐标；越界部分会被裁掉）
 */
export function opaqueBoundsInRect(
    data: Uint8ClampedArray | number[],
    imageWidth: number,
    imageHeight: number,
    rect: PixelRect,
    threshold: number = ALPHA_HIT_THRESHOLD,
): PixelRect | null {
    if (!(imageWidth > 0) || !(imageHeight > 0)) return null;
    const left = clampNumber(Math.floor(rect.x), 0, imageWidth);
    const top = clampNumber(Math.floor(rect.y), 0, imageHeight);
    const right = clampNumber(Math.ceil(rect.x + rect.width), 0, imageWidth);
    const bottom = clampNumber(Math.ceil(rect.y + rect.height), 0, imageHeight);
    if (!(right > left) || !(bottom > top)) return null;

    let minX = right;
    let maxX = left - 1;
    let minY = bottom;
    let maxY = top - 1;
    for (let y = top; y < bottom; y += 1) {
        const row = y * imageWidth;
        for (let x = left; x < right; x += 1) {
            const alpha = data[(row + x) * 4 + 3] ?? 0;
            if (alpha <= threshold) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < minX || maxY < minY) return null;
    return {x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1};
}

/** 两个包围盒取并集（null 当空处理） */
export function unionRect(a: PixelRect | null, b: PixelRect | null): PixelRect | null {
    if (!a) return b;
    if (!b) return a;
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const right = Math.max(a.x + a.width, b.x + b.width);
    const bottom = Math.max(a.y + a.height, b.y + b.height);
    return {x: left, y: top, width: right - left, height: bottom - top};
}

/** 一组包围盒的并集 */
export function unionRects(rects: (PixelRect | null)[]): PixelRect | null {
    let result: PixelRect | null = null;
    for (const rect of rects) result = unionRect(result, rect);
    return result;
}

/**
 * 原图像素包围盒 → **本体盒子内**的 CSS 像素矩形。
 *
 * 映射关系必须和绘制完全一致：精灵图层在 `box.left/top`，背景按
 * `background-size` 缩放、`background-position: -offsetX/-offsetY` 偏移，
 * 所以原图上的 `ax` 落在盒内 `box.left + ax × (backgroundWidth / imageWidth) - offsetX`。
 */
export function atlasBoundsToBox(
    box: Pick<FrameBox, 'left' | 'top' | 'offsetX' | 'offsetY' | 'backgroundWidth' | 'backgroundHeight'>,
    image: {imageWidth: number; imageHeight: number},
    bounds: PixelRect,
): PixelRect {
    const scaleX = image.imageWidth > 0 ? box.backgroundWidth / image.imageWidth : 0;
    const scaleY = image.imageHeight > 0 ? box.backgroundHeight / image.imageHeight : 0;
    return {
        x: box.left + bounds.x * scaleX - box.offsetX,
        y: box.top + bounds.y * scaleY - box.offsetY,
        width: Math.max(1, bounds.width * scaleX),
        height: Math.max(1, bounds.height * scaleY),
    };
}

/** 某一帧的包围盒换算到盒内坐标（没算到包围盒时返回 null） */
export function frameOpaqueRect(
    plan: AtlasPlan,
    bounds: FrameAlphaBounds,
    animation: number,
    frame: number,
): PixelRect | null {
    const cell = bounds[animation]?.[frame] ?? null;
    if (!cell) return null;
    return atlasBoundsToBox(frameBox(plan, animation, frame), plan, cell);
}

/**
 * 一个动画**所有帧**的包围盒并集（盒内坐标）。
 *
 * 为什么按动画而不是按帧：宿主每 60ms 轮询一次命中，按帧上报会让矩形随帧抖动
 * （事件风暴 + 点到一半判定变了）；按动画上报则只在切动画时更新一次。
 */
export function animationOpaqueRect(
    plan: AtlasPlan,
    bounds: FrameAlphaBounds,
    animation: number,
): PixelRect | null {
    const cells = bounds[animation];
    if (!cells || cells.length === 0) return null;
    return unionRects(cells.map((_cell, frame) => frameOpaqueRect(plan, bounds, animation, frame)));
}

/** 某个 look 方向的包围盒换算到盒内坐标（look 格子按基础缩放摆，见 `lookBox`） */
export function lookOpaqueRect(
    plan: AtlasPlan,
    look: (PixelRect | null)[] | null,
    direction: number,
): PixelRect | null {
    if (!look || look.length === 0) return null;
    const cell = look[((direction % look.length) + look.length) % look.length] ?? null;
    const box = lookBox(plan, direction);
    if (!cell || !box) return null;
    return atlasBoundsToBox(box, plan, cell);
}

/**
 * 把「盒内包围盒」换成窗口坐标的命中矩形：只取不透明像素并集，再放宽 `padding`。
 * 包围盒为空/非法时退回整个本体盒子（宁可多算一点，也不能让宠物点不到）。
 */
export function bodyHitRect(
    body: {x: number; y: number; width: number; height: number},
    opaque: PixelRect | null,
    padding: number = HIT_PADDING,
): {x: number; y: number; width: number; height: number} {
    if (!opaque || !(opaque.width > 0) || !(opaque.height > 0)) return body;
    const pad = Math.max(0, padding);
    const left = clampNumber(Math.floor(opaque.x - pad), 0, body.width);
    const top = clampNumber(Math.floor(opaque.y - pad), 0, body.height);
    const right = clampNumber(Math.ceil(opaque.x + opaque.width + pad), 0, body.width);
    const bottom = clampNumber(Math.ceil(opaque.y + opaque.height + pad), 0, body.height);
    if (!(right > left) || !(bottom > top)) return body;
    return {
        x: Math.round(body.x + left),
        y: Math.round(body.y + top),
        width: Math.max(1, Math.round(right - left)),
        height: Math.max(1, Math.round(bottom - top)),
    };
}

/** 某一格在图集里的原图矩形 */
function cellRectInAtlas(plan: AtlasPlan, column: number, row: number): PixelRect {
    return {
        x: column * plan.cellWidth,
        y: row * plan.cellHeight,
        width: plan.cellWidth,
        height: plan.cellHeight,
    };
}

/** 扫一格：把降采样坐标换回原图坐标，并按采样精度放宽（否则斜边会被切掉几个像素） */
function scanCell(
    sample: AlphaSample,
    rect: PixelRect,
    threshold: number,
): PixelRect | null {
    const scale = sample.scale > 0 ? sample.scale : 1;
    const sampled = opaqueBoundsInRect(
        sample.data,
        sample.width,
        sample.height,
        {
            x: rect.x * scale,
            y: rect.y * scale,
            width: rect.width * scale,
            height: rect.height * scale,
        },
        threshold,
    );
    if (!sampled) return null;
    /* 采样精度损失的补偿：1 个采样像素 ≈ 1/scale 个原图像素（scale=1 时无需补） */
    const pad = Math.max(1, Math.ceil(1 / scale));
    const x = clampNumber(sampled.x / scale - pad, rect.x, rect.x + rect.width);
    const y = clampNumber(sampled.y / scale - pad, rect.y, rect.y + rect.height);
    const right = clampNumber((sampled.x + sampled.width) / scale + pad, rect.x, rect.x + rect.width);
    const bottom = clampNumber(
        (sampled.y + sampled.height) / scale + pad,
        rect.y,
        rect.y + rect.height,
    );
    if (!(right > x) || !(bottom > y)) return null;
    return {x, y, width: right - x, height: bottom - y};
}

/**
 * 一次扫完所有动画帧与 16 个 look 方向的包围盒（原图像素坐标）。
 *
 * @param sample 降采样后的整张图集（`scale` 与坐标一起给，换算回原图）
 */
export function measureAtlasAlpha(
    sample: AlphaSample | null,
    plan: AtlasPlan,
    threshold: number = ALPHA_HIT_THRESHOLD,
): AlphaBounds {
    if (!sample || !(plan.cellWidth > 0) || !(plan.cellHeight > 0)) return EMPTY_ALPHA_BOUNDS;

    const frames: FrameAlphaBounds = plan.frames.map((animationFrames, animation) =>
        animationFrames.map((_offset, frame) => {
            const {column, row} = frameCell(plan, animation, frame);
            return scanCell(sample, cellRectInAtlas(plan, column, row), threshold);
        }),
    );

    /* look 格子没有单独的 cell 下标，只能按 lookBox 的逆运算反推（与绘制同一套取整） */
    const look = plan.lookFrames
        ? plan.lookFrames.map((offset) => {
              const column = Math.round(offset.x / Math.max(1, plan.cellWidth * plan.scale));
              const row = Math.round(offset.y / Math.max(1, plan.cellHeight * plan.scale));
              return scanCell(sample, cellRectInAtlas(plan, column, row), threshold);
          })
        : null;

    return {frames, look};
}
