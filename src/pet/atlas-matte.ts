/**
 * 图集的「去底」（**这里只有纯逻辑**，真正画 canvas 的动作在 `core-pet.ts` 里）。
 *
 * 为什么需要：社区宠物包常见两种图集——
 * 1. 带 alpha 的透明图（我们自己的、以及 Codex Pet 规范要求的）；
 * 2. **白底/单色底、没有 alpha 的图**（导出时被压平了，用户手上的素材经常是这种）。
 * 第 2 种直接画会出现一个白方块，所以渲染前先判断「这张图有没有透明像素」；
 * 没有就把它当成「底色要去掉」，用角落像素当底色、按容差抠掉。
 *
 * 判定抽成纯函数的原因：它决定「要不要抠、抠哪个颜色」，错了就是整只宠物变透明或者白框，
 * 而这类错误在界面上只能靠眼睛发现。
 */

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

/** 抠底容差（每个通道的最大差）；太小会留白边，太大会吃掉浅色羽毛/头发 */
export const MATTE_TOLERANCE = 18;

/** 采样上限：超过这个边长的图不做逐像素判断（防止一次卡死界面） */
export const MAX_MATTE_SIZE = 4096;

/**
 * 图集的 MIME：**必须按文件类型给**。
 *
 * 踩过的坑：图集解码原来写死 `data:image/png;base64,…`，而 Codex Pet 的图集是 **webp**；
 * 类型写错时浏览器不会按内容嗅探，`Image.onerror` 直接走「退回程序化渲染」——
 * 表现是「导入成功、但右下角只有一个圆」。所以这里按扩展名给出正确类型。
 */
export function atlasMime(file: string): string {
    const lower = file.toLowerCase();
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.png')) return 'image/png';
    /* 兜底：核心只放行 png/webp，走到这里说明文件名没扩展名，用 png（多数素材是 png） */
    return 'image/png';
}

/** 把 base64 图集包装成可直接喂给 `Image` 的 data URL */
export function atlasDataUrl(dataBase64: string, file: string): string {
    return `data:${atlasMime(file)};base64,${dataBase64}`;
}

/**
 * 判断一张图是否**没有**透明像素（→ 需要抠底）。
 *
 * @returns 需要抠底时返回底色（取左上角像素），否则 `null`
 */
export function backgroundToStrip(
    data: Uint8ClampedArray | number[],
    width: number,
    height: number,
    tolerance: number = MATTE_TOLERANCE,
): Rgb | null {
    if (width <= 0 || height <= 0) return null;
    if (width > MAX_MATTE_SIZE || height > MAX_MATTE_SIZE) return null;
    const pixels = Math.min(width * height, Math.floor(data.length / 4));
    if (pixels <= 0) return null;

    /* 只要有一个像素不是全不透明，就认为这张图本来就带透明，别动它 */
    for (let index = 0; index < pixels; index += 1) {
        if ((data[index * 4 + 3] ?? 255) < 250) return null;
    }
    const r = data[0] ?? 0;
    const g = data[1] ?? 0;
    const b = data[2] ?? 0;
    /* 全不透明而且角落本身就很暗/很饱和：可能是「没有背景」的满幅图，别乱抠 */
    if (r + g + b < 60) return null;
    void tolerance;
    return {r, g, b};
}

/** 把与底色足够接近的像素变成透明（就地修改，返回清掉的像素数） */
export function stripBackground(
    data: Uint8ClampedArray,
    background: Rgb,
    tolerance: number = MATTE_TOLERANCE,
): number {
    let cleared = 0;
    for (let index = 0; index < data.length; index += 4) {
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const a = data[index + 3];
        if (a !== 255) continue;
        if (
            Math.abs(r - background.r) <= tolerance &&
            Math.abs(g - background.g) <= tolerance &&
            Math.abs(b - background.b) <= tolerance
        ) {
            data[index + 3] = 0;
            cleared += 1;
        }
    }
    return cleared;
}
