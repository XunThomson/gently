/**
 * 宠物窗口的摆放（**纯函数**，不碰 Tauri API）。
 *
 * 默认位置：**主屏右下角**、离边缘 `margin` 像素——宠物在屏幕角落里不挡内容，
 * 也不会被音乐软件的窗口边界限制（这正是它独立成窗口的目的）。
 * 用户拖动过就尊重用户的位置，但要把窗口夹回**看得见**的范围内：
 * 副屏被拔掉 / 分辨率变了之后，上次的坐标可能落在屏幕外（窗口「消失」）。
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

/** 默认离屏幕边缘的距离（像素） */
export const PET_WINDOW_MARGIN = 32;

/**
 * 计算宠物窗口位置。
 *
 * @param saved 用户上次拖动后的左上角坐标（没有就传 `null`）
 * @param monitors 所有显示器（物理像素：`position` + `size`）
 * @param size 宠物窗口自身尺寸（物理像素）
 */
export function placePet(saved: Point | null, monitors: Rect[], size: {width: number; height: number}): Point {
    const primary = monitors[0];
    if (!primary) return saved ?? {x: 0, y: 0};

    if (saved) {
        /* 只要窗口有足够的像素落在某块屏幕里，就认为它「还看得见」：
           要求整窗可见太严（用户可能故意让它半探出屏幕边缘）。 */
        const visible = monitors.some((monitor) => {
            const overlapX = Math.min(saved.x + size.width, monitor.x + monitor.width) - Math.max(saved.x, monitor.x);
            const overlapY = Math.min(saved.y + size.height, monitor.y + monitor.height) - Math.max(saved.y, monitor.y);
            return overlapX >= size.width / 2 && overlapY >= size.height / 2;
        });
        if (visible) return saved;
    }

    return {
        x: primary.x + primary.width - size.width - PET_WINDOW_MARGIN,
        y: primary.y + primary.height - size.height - PET_WINDOW_MARGIN,
    };
}
