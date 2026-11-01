/**
 * 图集解码 + 逐帧绘制（**DOM 部分集中在这里**）。
 *
 * 为什么单独一层：图集在三个地方要用——宠物窗口的渲染器、设置页的预览缩略图、将来的预览视频。
 * 解码（含 MIME 判定与白底去底）只有一份实现，谁要画就自己拿 `decodeAtlas` 的结果去画。
 */

import {
    MAX_MATTE_SIZE,
    atlasDataUrl,
    backgroundToStrip,
    stripBackground,
} from './atlas-matte';
import {frameBox, planAtlas, type AtlasPlan} from './frame-layout';

export interface DecodedAtlas {
    image: HTMLImageElement;
    /** 已去底（或本来就有 alpha）的图片 URL */
    url: string;
    plan: AtlasPlan;
}

/** 把 base64 图集解码成可以画的图片，并按规格算好帧偏移；失败返回 `null` */
export async function decodeAtlas(
    dataBase64: string,
    file: string,
    animations: {name: string; frames: number; row?: number | null}[],
    layout: {frameWidth: number; frameHeight: number; columns: number; rows: number} | null,
    lookRows: [number, number] | null,
    displayHeight: number,
): Promise<DecodedAtlas | null> {
    try {
        const url = atlasDataUrl(dataBase64, file);
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error('atlas decode failed'));
            image.src = url;
        });
        const plan = planAtlas(
            {animations, atlasLayout: layout, lookRows},
            image.naturalWidth,
            image.naturalHeight,
            displayHeight,
        );
        if (!plan) return null;
        return {image, url: matteAtlas(image) ?? url, plan};
    } catch {
        return null;
    }
}

/** 取图集里某一帧的源矩形（原图像素坐标；永远是整整一格，不受 fit 影响） */
export function frameSourceRect(
    decoded: {image: HTMLImageElement; plan: AtlasPlan},
    animation: number,
    frame: number,
): {x: number; y: number; w: number; h: number} | null {
    const box = frameBox(decoded.plan, animation, frame);
    const index = Number.isInteger(animation) && animation >= 0 ? animation : 0;
    const scale = decoded.plan.animationScales[index] ?? decoded.plan.scale;
    const anchor = decoded.plan.anchors[index] ?? {x: 0, y: 0};
    if (!(scale > 0)) return null;
    /* 盒子里算出来的偏移含锚点；源矩形只认格子本身，所以把锚点减回去 */
    return {
        x: (box.offsetX - anchor.x) / scale,
        y: (box.offsetY - anchor.y) / scale,
        w: decoded.plan.cellWidth,
        h: decoded.plan.cellHeight,
    };
}

/**
 * 把某一帧画到 2D 上下文里（等比缩放到目标盒子内，保持像素画清晰）。
 *
 * **按 plan 的盒子整体缩放**：这样各个动画（各自的 `fit`）之间的相对大小才不会在缩略图里失真，
 * 也和宠物窗口里看到的一致。
 */
export function drawAtlasFrame(
    context: CanvasRenderingContext2D,
    decoded: {image: HTMLImageElement; plan: AtlasPlan},
    animation: number,
    frame: number,
    boxWidth: number,
    boxHeight: number,
): boolean {
    const source = frameSourceRect(decoded, animation, frame);
    if (!source) return false;
    const index =
        Number.isInteger(animation) && animation >= 0 && animation < decoded.plan.frames.length
            ? animation
            : 0;
    const size = decoded.plan.frameSizes[index] ?? {width: decoded.plan.width, height: decoded.plan.height};
    const anchor = decoded.plan.anchors[index] ?? {x: 0, y: 0};
    /* 整个盒子等比放进目标框，再按锚点摆这一格 */
    const fit = Math.min(boxWidth / decoded.plan.width, boxHeight / decoded.plan.height);
    const w = size.width * fit;
    const h = size.height * fit;
    const left = (boxWidth - decoded.plan.width * fit) / 2 + anchor.x * fit;
    const top = (boxHeight - decoded.plan.height * fit) / 2 + anchor.y * fit;
    context.clearRect(0, 0, boxWidth, boxHeight);
    context.imageSmoothingEnabled = false;
    context.drawImage(
        decoded.image,
        source.x,
        source.y,
        source.w,
        source.h,
        left,
        top,
        w,
        h,
    );
    return true;
}

/**
 * 「去底」：把没有 alpha 的图集画到 canvas 上，按角落底色抠成透明，再交回一个 data URL。
 *
 * 用 canvas 而不是在核心里做：核心没有图像解码能力（也不想为一张图引入 image 依赖），
 * 而浏览器本来就要解码这张图——顺手做一次像素处理是最省的路径。
 * 失败（画布不可用、超大图）就原样返回 `null`，调用方继续用原图。
 */
function matteAtlas(image: HTMLImageElement): string | null {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!(width > 0) || !(height > 0)) return null;
    if (width > MAX_MATTE_SIZE || height > MAX_MATTE_SIZE) return null;
    try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.drawImage(image, 0, 0);
        const frame = context.getImageData(0, 0, width, height);
        const background = backgroundToStrip(frame.data, width, height);
        if (!background) return null;
        stripBackground(frame.data, background);
        context.putImageData(frame, 0, 0);
        return canvas.toDataURL('image/png');
    } catch {
        return null;
    }
}


