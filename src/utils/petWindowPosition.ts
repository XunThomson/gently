/**
 * 宠物窗口的摆放（**纯函数**，不碰 Tauri API）。
 *
 * 关键约束：**夹的是宠物本体，不是窗口**。
 * 窗口只是本体周围一圈透明的画布；状态卡 / 操作菜单（HUD）放不下的问题，
 * 不能反过来决定宠物能站哪、能贴多近。
 *
 * 现在的做法：
 * 1. 窗口是以本体为中心、四边各留一圈 HUD 槽位的画布——本体在窗口里的位置是常量；
 * 2. 窗口允许越出屏幕。以后加「贴边爬行」时，本体可以挂在屏幕边缘外，
 *    窗口仍有画布把越界部分画出来（`edgeOverhang`）；默认 0，本体整只可见；
 * 3. HUD 槽位单独计算：贴着左右边时放到本体内侧（更直观），其余情况优先上下；
 *    槽位再夹一次，保证**永远整块留在屏幕里**，也永远不超出窗口画布。
 */

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface Point {
    x: number;
    y: number;
}

export type PetHudSide = 'above' | 'below' | 'left' | 'right';

export interface PetHudSpec {
    width: number;
    height: number;
    /** HUD 与本体之间的呼吸距离 */
    gap: number;
}

export interface PetLayout {
    /** 窗口左上角（物理像素；允许为负 / 超出屏幕） */
    window: Point;
    /** 本体脚底中心在窗口内的位置（物理像素） */
    anchor: Point;
    /** 状态卡 / 气泡 / 菜单放在本体的哪一边 */
    hud: PetHudSide;
    /** HUD 槽位在窗口内的矩形（物理像素；槽位本身已夹进屏幕） */
    hudRect: Rect;
}

export interface PetLayoutOptions {
    /**
     * 本体允许伸出屏幕边缘的最大距离（物理像素）。
     *
     * 默认 0（本体整只可见）。贴边爬行这类动画需要让本体挂在屏幕边缘外时传 > 0；
     * HUD 不受影响，仍然整块留在屏幕里。
     */
    edgeOverhang?: number;
}

/** 默认离屏幕边缘的距离（像素） */
export const PET_WINDOW_MARGIN = 32;

/**
 * HUD 槽位的一边长。
 *
 * 必须放得下「菜单 + 一小段气泡」：菜单有 6 行，气泡再占一行。
 */
export const PET_HUD_RESERVE = 260;

/** 本体与 HUD 之间的呼吸距离 */
export const PET_HUD_GAP = 8;

function clampNumber(value: number, min: number, max: number): number {
    /* 显示器比内容还小时 max < min：退回 min（至少不会算出 NaN / 屏幕外） */
    return max >= min ? Math.min(Math.max(value, min), max) : min;
}

/** 与矩形重叠面积最大的屏幕；都不重叠时选中心最近的那块 */
function pickMonitor(rect: Rect, monitors: Rect[]): Rect {
    let target = monitors[0];
    let bestOverlap = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const monitor of monitors) {
        const overlapWidth =
            Math.min(rect.x + rect.width, monitor.x + monitor.width) - Math.max(rect.x, monitor.x);
        const overlapHeight =
            Math.min(rect.y + rect.height, monitor.y + monitor.height) - Math.max(rect.y, monitor.y);
        const overlap = Math.max(0, overlapWidth) * Math.max(0, overlapHeight);
        const dx = rect.x + rect.width / 2 - (monitor.x + monitor.width / 2);
        const dy = rect.y + rect.height / 2 - (monitor.y + monitor.height / 2);
        const distance = dx * dx + dy * dy;
        if (overlap > bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
            bestOverlap = overlap;
            bestDistance = distance;
            target = monitor;
        }
    }
    return target;
}

/**
 * 按「本体脚底锚点」摆窗口与 HUD。
 *
 * @param anchor 想要的本体脚底中心（屏幕物理像素）
 * @param body 本体尺寸（物理像素）
 * @param hud HUD 槽位尺寸与间距（物理像素）
 * @param size 宠物窗口画布尺寸（物理像素；四边应各留出 hud 槽位 + 间距）
 * @param monitors 所有显示器（物理像素）
 * @param options `edgeOverhang`：允许本体伸出屏幕边缘的距离
 */
export function layoutPetWindow(
    anchor: Point,
    body: {width: number; height: number},
    hud: PetHudSpec,
    size: {width: number; height: number},
    monitors: Rect[],
    options: PetLayoutOptions = {},
): PetLayout {
    const halfWidth = size.width / 2;
    const halfHeight = size.height / 2;

    if (monitors.length === 0) {
        const window = {
            x: Math.round(anchor.x - halfWidth),
            y: Math.round(anchor.y - halfHeight),
        };
        const localAnchor = {x: anchor.x - window.x, y: anchor.y - window.y};
        return {
            window,
            anchor: localAnchor,
            hud: 'above',
            hudRect: {
                x: localAnchor.x - hud.width / 2,
                y: localAnchor.y - body.height / 2 - hud.gap - hud.height,
                width: hud.width,
                height: hud.height,
            },
        };
    }

    const desired = {
        x: anchor.x - body.width / 2,
        y: anchor.y - body.height,
        width: body.width,
        height: body.height,
    };
    const monitor = pickMonitor(desired, monitors);
    const monitorRight = monitor.x + monitor.width;
    const monitorBottom = monitor.y + monitor.height;

    /* 1. 本体是唯一被夹的东西：默认整只可见，需要贴边爬行时可伸出 edgeOverhang */
    const overhangX = Math.min(Math.max(options.edgeOverhang ?? 0, 0), body.width);
    const overhangY = Math.min(Math.max(options.edgeOverhang ?? 0, 0), body.height);
    const bodyX = clampNumber(desired.x, monitor.x - overhangX, monitorRight - body.width + overhangX);
    const bodyY = clampNumber(desired.y, monitor.y - overhangY, monitorBottom - body.height + overhangY);
    const bodyRight = bodyX + body.width;
    const bodyBottom = bodyY + body.height;
    const centerX = bodyX + body.width / 2;
    const centerY = bodyY + body.height / 2;

    /* 2. 四个方向的候选槽位：主轴位置贴着本体，另一轴居中后夹进屏幕 */
    const clampHudX = (x: number) => clampNumber(x, monitor.x, monitorRight - hud.width);
    const clampHudY = (y: number) => clampNumber(y, monitor.y, monitorBottom - hud.height);
    const slots: Record<PetHudSide, Rect> = {
        above: {
            x: clampHudX(centerX - hud.width / 2),
            y: bodyY - hud.gap - hud.height,
            width: hud.width,
            height: hud.height,
        },
        below: {
            x: clampHudX(centerX - hud.width / 2),
            y: bodyBottom + hud.gap,
            width: hud.width,
            height: hud.height,
        },
        left: {
            x: bodyX - hud.gap - hud.width,
            y: clampHudY(centerY - hud.height / 2),
            width: hud.width,
            height: hud.height,
        },
        right: {
            x: bodyRight + hud.gap,
            y: clampHudY(centerY - hud.height / 2),
            width: hud.width,
            height: hud.height,
        },
    };
    const fullyInside = (rect: Rect): boolean =>
        rect.width <= monitor.width &&
        rect.height <= monitor.height &&
        rect.x >= monitor.x &&
        rect.y >= monitor.y &&
        rect.x + rect.width <= monitorRight &&
        rect.y + rect.height <= monitorBottom;

    /* 3. 贴左右边时优先放到本体内侧（侧边卡片）；其余情况优先上下 */
    const sideRoom = hud.width + hud.gap;
    const nearLeft = bodyX - monitor.x < sideRoom;
    const nearRight = monitorRight - bodyRight < sideRoom;
    const preference: PetHudSide[] = [];
    if (nearLeft !== nearRight) preference.push(nearLeft ? 'right' : 'left');
    preference.push('above', 'below', 'left', 'right');

    const rooms: Record<PetHudSide, number> = {
        above: bodyY - monitor.y,
        below: monitorBottom - bodyBottom,
        left: bodyX - monitor.x,
        right: monitorRight - bodyRight,
    };
    let hudSide = preference.find((side) => fullyInside(slots[side]));
    if (!hudSide) {
        /* 屏幕连一个完整槽位都放不下（比 HUD 还小）：选空间最大的一边，槽位已夹进屏幕 */
        hudSide = (['above', 'below', 'left', 'right'] as const).reduce(
            (best, side) => (rooms[side] > rooms[best] ? side : best),
            'above' as PetHudSide,
        );
    }
    const chosen = slots[hudSide];
    /* 连完整槽位都放不下时，至少把槽位夹进屏幕（可能压到本体，但面板不会跑到屏幕外） */
    const hudSlot = {
        x: clampHudX(chosen.x),
        y: clampHudY(chosen.y),
        width: chosen.width,
        height: chosen.height,
    };

    /* 4. 窗口是本体四周各留一圈 HUD 槽位的画布，允许越界。
       本体必须**四边等距**：以脚底为中心会让上方留白只剩 pad - 身高/2，
       上方菜单仍然会被窗口上沿裁掉。 */
    const padX = Math.max(0, (size.width - body.width) / 2);
    const padY = Math.max(0, (size.height - body.height) / 2);
    const window = {
        x: Math.round(bodyX - padX),
        y: Math.round(bodyY - padY),
    };
    return {
        window,
        anchor: {x: centerX - window.x, y: bodyBottom - window.y},
        hud: hudSide,
        hudRect: {
            x: hudSlot.x - window.x,
            y: hudSlot.y - window.y,
            width: hudSlot.width,
            height: hudSlot.height,
        },
    };
}

/**
 * 计算宠物窗口位置。
 *
 * @param saved 用户上次拖动后的**本体脚底锚点**（没有就传 `null`）
 * @param monitors 所有显示器（物理像素：`position` + `size`）
 * @param body 本体尺寸（物理像素）
 * @param hud HUD 槽位尺寸与间距（物理像素）
 * @param size 宠物窗口画布尺寸（物理像素）
 * @param options `edgeOverhang`：允许本体伸出屏幕边缘的距离
 */
export function placePet(
    saved: Point | null,
    monitors: Rect[],
    body: {width: number; height: number},
    hud: PetHudSpec,
    size: {width: number; height: number},
    options?: PetLayoutOptions,
): PetLayout {
    const primary = monitors[0];
    if (!primary) return layoutPetWindow(saved ?? {x: 0, y: 0}, body, hud, size, monitors, options);

    /* 默认：主屏右下角，本体离边缘 PET_WINDOW_MARGIN（不是窗口离边缘） */
    const fallback = {
        x: primary.x + primary.width - PET_WINDOW_MARGIN - body.width / 2,
        y: primary.y + primary.height - PET_WINDOW_MARGIN,
    };
    return layoutPetWindow(saved ?? fallback, body, hud, size, monitors, options);
}
