/**
 * 图集布局（**纯函数**，不碰 DOM）：把 `pet.json` 的动画表 + 图片尺寸，算成
 * 「画哪一格、画多大」。
 *
 * 两种图集共存：
 * - **网格（`atlasLayout`）**：一格一个帧，第 N 个动画取第 N 行（或它自己写的 `row`）。
 *   sprite sheet 直接交进来就能用，作者不用先拼成一条长图。
 * - **单行帧条（没有 `atlasLayout`）**：按「所有动画帧数之和」把整图横向等分（老格式）。
 *
 * 抽成纯函数的原因：行/列/帧数三者是同一张图的三种坐标，算错只会表现成「画出来半个头」，
 * 在界面上极难定位；这里可以用假图片尺寸把两种布局都断言出来。
 *
 * **显示适配（`fit`）**：素材常常是分几批画的，同一张图集里各行角色的实际比例能差 20%，
 * 于是「待机 → 跑」时宠物会突然变大。`fit.scale` 把整行等比缩放，`fit.offsetX/offsetY`
 * 再微调位置（单位是**原图像素**）。为了让放大后的行不被裁切，画布盒子取所有行里最大的那个，
 * 每行按「水平居中 + 底部对齐」放进盒子里——脚底不动，看起来才像同一个角色。
 */

/** 某一行的显示适配（可选）：不写就是原样画 */
export interface LayoutAnimationFit {
    /** 相对整格的倍数（1 = 不缩放） */
    scale?: number | null;
    /** 原图像素为单位的微调 */
    offsetX?: number | null;
    offsetY?: number | null;
}

/** 一个动画（只需要布局相关的字段） */
export interface LayoutAnimation {
    name: string;
    frames: number;
    /** 网格图集里的行号（0 起）；不写按声明顺序 */
    row?: number | null;
    fit?: LayoutAnimationFit | null;
}

/** 网格图集：每格 `frameWidth × frameHeight`，一行一个动画 */
export interface AtlasLayout {
    frameWidth: number;
    frameHeight: number;
    columns: number;
    rows: number;
}

/** 一份宠物规格里与画图有关的部分 */
export interface LayoutSpec {
    animations: LayoutAnimation[];
    atlasLayout?: AtlasLayout | null;
    /** 「看向哪边」的两行（16 个方向，0 = 正上、顺时针）；没有就不支持 look */
    lookRows?: [number, number] | null;
}

/** 某一帧在图上的位置（已按显示高度缩放） */
export interface FrameOffset {
    x: number;
    y: number;
}

/** 某个动画某一帧要用的 CSS/画布参数（都算好，调用方只管贴） */
export interface FrameBox {
    /** 容器（盒子）尺寸：所有动画里最大的那个格子，取整。容器必须裁掉溢出，
        否则放大后的那一行旁边会露出**别的格子**的像素 */
    width: number;
    height: number;
    /** 这一格在盒子里的左上角（水平居中 + 底部对齐 + fit 偏移） */
    left: number;
    top: number;
    /** 这一格的显示尺寸（已含 fit 缩放） */
    frameWidth: number;
    frameHeight: number;
    /** `background-size`：整张图在该动画缩放下的尺寸 */
    backgroundSize: string;
    /** `background-position` 的绝对值（调用方取负；相对这一格的左上角） */
    offsetX: number;
    offsetY: number;
}

export interface AtlasPlan {
    /** 默认（第一个动画）的 `background-size`：老调用方还在用 */
    backgroundSize: string;
    /** 元素尺寸（盒子，不是单帧尺寸）：所有动画里最大的那个格子 */
    width: number;
    height: number;
    /** `[动画下标][帧下标] → 该动画缩放下的背景偏移`（不含盒子锚点） */
    frames: FrameOffset[][];
    /** 原图 → 显示尺寸的基础缩放比（缩略图/取源矩形时要折回去） */
    scale: number;
    /** 16 个 look 方向的偏移（没有 lookRows 时是 null；按基础缩放算） */
    lookFrames: FrameOffset[] | null;
    /** 每个动画实际的缩放比（基础缩放 × fit.scale） */
    animationScales: number[];
    /** 每个动画的单帧显示尺寸（已含 fit） */
    frameSizes: {width: number; height: number}[];
    /** 每个动画在盒子里的左上角（水平居中 + 底部对齐 + fit 偏移） */
    anchors: FrameOffset[];
    /** 原图像素尺寸与单格尺寸（取源矩形用） */
    imageWidth: number;
    imageHeight: number;
    cellWidth: number;
    cellHeight: number;
}

/**
 * 显示高度（与 CSS 里的宠物高度一致）。
 *
 * 为什么是 104 而不是 96：内置素材的格子是 192×208，**104 = 208/2** 正好是整数倍缩放。
 * 像素画一旦按非整数比例（比如 96/208 = 0.46）平滑缩放，边缘会出现黑色颗粒/毛边
 * ——这就是「宠物身上有黑点」的根因。配合 CSS 的 `image-rendering: pixelated`，
 * 0.5 倍是「2×2 像素块合成 1 像素」，画面干净且没有插值噪声。
 */
export const ATLAS_DISPLAY_HEIGHT = 104;

/** 往最近的整数像素取整：背景偏移落在半像素上，浏览器会做一次重采样（又是毛边） */
function px(value: number): number {
    return Math.round(value);
}

/** 背景在浏览器里实际渲染出的尺寸（`background-size` 是取整后的 px） */
function backgroundSizeOf(
    image: {imageWidth: number; imageHeight: number},
    scale: number,
): {width: number; height: number} {
    return {
        width: Math.max(1, px(image.imageWidth * scale)),
        height: Math.max(1, px(image.imageHeight * scale)),
    };
}

/**
 * 背景里一格的**实际**尺寸（以取整后的 `background-size` 为准）。
 *
 * 不能用 `cellWidth × scale` 直接算：`background-size` 取整后，格边界会落在小数像素上
 * （比如 1.08 倍时格子实际是 207.375px）。只要起点向上、终点向下取整，
 * 窗口就严格落在格子里，`image-rendering: pixelated` 不会采到邻居的最后一列/行。
 */
function renderedCell(
    plan: {imageWidth: number; imageHeight: number; cellWidth: number; cellHeight: number},
    scale: number,
): {background: {width: number; height: number}; width: number; height: number} {
    const background = backgroundSizeOf(plan, scale);
    return {
        background,
        width: (plan.cellWidth * background.width) / plan.imageWidth,
        height: (plan.cellHeight * background.height) / plan.imageHeight,
    };
}

/** 第 `index` 格在背景里的安全窗口（起点 ceil、终点 floor，容差防浮点抖动） */
function safeCellWindow(index: number, cellSize: number): {offset: number; size: number} {
    const offset = Math.ceil(index * cellSize - 1e-6);
    const end = Math.floor((index + 1) * cellSize + 1e-6);
    return {offset, size: Math.max(1, end - offset)};
}

/** 读一行动画的适配参数（缺省 = 原样） */
function fitOf(animation: LayoutAnimation): {scale: number; offsetX: number; offsetY: number} {
    const scale = animation.fit?.scale;
    return {
        scale: typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1,
        offsetX: animation.fit?.offsetX ?? 0,
        offsetY: animation.fit?.offsetY ?? 0,
    };
}

/**
 * 计算图集布局；参数不成立时返回 `null`（调用方退回程序化渲染，而不是画错）。
 */
export function planAtlas(
    spec: LayoutSpec,
    imageWidth: number,
    imageHeight: number,
    displayHeight: number = ATLAS_DISPLAY_HEIGHT,
): AtlasPlan | null {
    if (!(imageWidth > 0) || !(imageHeight > 0) || !(displayHeight > 0)) return null;
    const animations = spec.animations ?? [];
    if (animations.length === 0) return null;

    const layout = spec.atlasLayout ?? null;
    if (layout) {
        if (!(layout.frameWidth > 0) || !(layout.frameHeight > 0)) return null;
        if (!(layout.columns > 0) || !(layout.rows > 0)) return null;
        return buildPlan(spec, animations, imageWidth, imageHeight, displayHeight, {
            cellWidth: layout.frameWidth,
            cellHeight: layout.frameHeight,
            columns: layout.columns,
            frameX: (_animation, frame) => frame,
            frameY: (animation, index) => animation.row ?? index,
        });
    }

    // 单行帧条：帧宽由「总帧数」等分得到（老格式必须保持原样）
    const totalFrames = animations.reduce(
        (sum, animation) => sum + Math.max(1, animation.frames),
        0,
    );
    const cellWidth = imageWidth / totalFrames;
    const starts = animations.reduce<number[]>((list, _animation, index) => {
        list.push(index === 0 ? 0 : list[index - 1] + Math.max(1, animations[index - 1].frames));
        return list;
    }, []);
    return buildPlan(spec, animations, imageWidth, imageHeight, displayHeight, {
        cellWidth,
        cellHeight: imageHeight,
        columns: totalFrames,
        frameX: (_animation, frame, index) => starts[index] + frame,
        frameY: () => 0,
    });
}

interface CellGrid {
    /** 原图像素 */
    cellWidth: number;
    cellHeight: number;
    columns: number;
    /** 第 `frame` 帧落在第几列 */
    frameX: (_animation: LayoutAnimation, frame: number, index: number) => number;
    /** 第 `index` 个动画落在第几行 */
    frameY: (animation: LayoutAnimation, index: number) => number;
}

function buildPlan(
    spec: LayoutSpec,
    animations: LayoutAnimation[],
    imageWidth: number,
    imageHeight: number,
    displayHeight: number,
    grid: CellGrid,
): AtlasPlan | null {
    const baseScale = displayHeight / grid.cellHeight;
    if (!(baseScale > 0)) return null;

    const animationScales: number[] = [];
    const frameSizes: {width: number; height: number}[] = [];
    const anchors: FrameOffset[] = [];
    const frames: FrameOffset[][] = [];
    for (const [index, animation] of animations.entries()) {
        const fit = fitOf(animation);
        const scale = baseScale * fit.scale;
        animationScales.push(scale);
        frameSizes.push({
            width: px(grid.cellWidth * scale),
            height: px(grid.cellHeight * scale),
        });
        const count = Math.min(Math.max(1, animation.frames), Math.max(1, grid.columns));
        frames.push(
            Array.from({length: count}, (_, frame) => ({
                x: px(grid.frameX(animation, frame, index) * grid.cellWidth * scale),
                y: px(grid.frameY(animation, index) * grid.cellHeight * scale),
            })),
        );
        anchors.push({x: 0, y: 0});
    }

    /* 盒子取所有动画里最大的那一格：放大后的行才不会被裁掉 */
    const boxWidth = Math.max(1, ...frameSizes.map((size) => size.width));
    const boxHeight = Math.max(1, ...frameSizes.map((size) => size.height));

    /* 每行放进盒子：水平居中 + 底部对齐，再叠加 fit 偏移（原图像素 → 显示像素） */
    for (const [index, animation] of animations.entries()) {
        const fit = fitOf(animation);
        const size = frameSizes[index];
        anchors[index] = {
            x: px((boxWidth - size.width) / 2) + px(fit.offsetX * animationScales[index]),
            y: px(boxHeight - size.height) + px(fit.offsetY * animationScales[index]),
        };
    }

    const lookFrames = spec.lookRows
        ? Array.from({length: 16}, (_, dir) => {
            const column = dir % grid.columns;
            const row = spec.lookRows![0] + Math.floor(dir / grid.columns);
            return {
                x: px(column * grid.cellWidth * baseScale),
                y: px(row * grid.cellHeight * baseScale),
            };
        })
        : null;

    return {
        backgroundSize: `${px(imageWidth * animationScales[0])}px ${px(
            imageHeight * animationScales[0],
        )}px`,
        width: boxWidth,
        height: boxHeight,
        frames,
        scale: baseScale,
        lookFrames,
        animationScales,
        frameSizes,
        anchors,
        imageWidth,
        imageHeight,
        cellWidth: grid.cellWidth,
        cellHeight: grid.cellHeight,
    };
}

/**
 * 某一帧落在图集的第几列 / 第几行。
 *
 * 偏移值里已经带了「列 × 格宽」的取整误差，除回去再四舍五入就能还原下标
 * （缩略图要按原图格子取源矩形，不能从背景偏移反推小数坐标）。
 */
export function frameCell(plan: AtlasPlan, animation: number, frame: number): {column: number; row: number} {
    const index =
        Number.isInteger(animation) && animation >= 0 && animation < plan.frames.length
            ? animation
            : 0;
    const offsets = plan.frames[index] ?? plan.frames[0] ?? [];
    const offset = offsets[frame] ?? offsets[0] ?? {x: 0, y: 0};
    const scale = plan.animationScales[index] ?? plan.scale;
    const cellWidth = plan.cellWidth * scale;
    const cellHeight = plan.cellHeight * scale;
    return {
        column: cellWidth > 0 ? Math.round(offset.x / cellWidth) : 0,
        row: cellHeight > 0 ? Math.round(offset.y / cellHeight) : 0,
    };
}

/** 取某个 look 方向那一格的绘制参数（look 两行永远按基础缩放：它们是「同一张脸」的不同朝向） */
export function lookBox(plan: AtlasPlan, look: number): FrameBox | null {
    if (!plan.lookFrames) return null;
    const offset = plan.lookFrames[look % plan.lookFrames.length] ?? plan.lookFrames[0];
    if (!offset) return null;
    const width = px(plan.cellWidth * plan.scale);
    const height = px(plan.cellHeight * plan.scale);
    const anchor = {
        x: px((plan.width - width) / 2),
        y: px(plan.height - height),
    };
    const cell = renderedCell(plan, plan.scale);
    const column = plan.cellWidth > 0 ? Math.round(offset.x / (plan.cellWidth * plan.scale)) : 0;
    const row = plan.cellHeight > 0 ? Math.round(offset.y / (plan.cellHeight * plan.scale)) : 0;
    const window = safeCellWindow(column, cell.width);
    const rows = safeCellWindow(row, cell.height);
    return {
        width: plan.width,
        height: plan.height,
        left: anchor.x + Math.round((width - window.size) / 2),
        top: anchor.y + (height - rows.size),
        frameWidth: window.size,
        frameHeight: rows.size,
        backgroundSize: `${cell.background.width}px ${cell.background.height}px`,
        offsetX: window.offset,
        offsetY: rows.offset,
    };
}

/** 取某个动画某一帧的绘制参数（下标越界时退回第一个） */
export function frameBox(plan: AtlasPlan, animation: number, frame: number): FrameBox {
    const index =
        Number.isInteger(animation) && animation >= 0 && animation < plan.frames.length
            ? animation
            : 0;
    const anchor = plan.anchors[index] ?? {x: 0, y: 0};
    const scale = plan.animationScales[index] ?? plan.scale;
    const size = plan.frameSizes[index] ?? {width: plan.width, height: plan.height};
    const cell = renderedCell(plan, scale);
    const {column, row} = frameCell(plan, animation, frame);
    const window = safeCellWindow(column, cell.width);
    const rows = safeCellWindow(row, cell.height);
    return {
        width: plan.width,
        height: plan.height,
        /* 安全窗口比名义尺寸小 0~1px：水平居中、底部对齐，脚底不会因为少画一行而上浮 */
        left: anchor.x + Math.round((size.width - window.size) / 2),
        top: anchor.y + (size.height - rows.size),
        frameWidth: window.size,
        frameHeight: rows.size,
        backgroundSize: `${cell.background.width}px ${cell.background.height}px`,
        offsetX: window.offset,
        offsetY: rows.offset,
    };
}




