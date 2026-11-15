/**
 * 宠物窗口的**可交互区域**（多个矩形）登记与上报。
 *
 * 为什么是「多个矩形」：宠物窗口里有两个东西应该吃鼠标——
 * 1. 精灵本体（点它 = 摸摸、拖它 = 移动窗口）；
 * 2. 悬停状态卡 / 右键菜单（显示时才登记，隐藏时量出来是 0 尺寸 → 自动跳过）。
 * 只上报精灵矩形会让面板按钮点不到（宿主把整窗设成点击穿透）；
 * 而把整窗都算进去，又会让透明区域挡住下面的应用。
 *
 * 上报策略：每次渲染时重新量一遍，**内容变了才**发事件（宿主只要最新值）。
 * 特别注意「空列表」：窗口隐藏 / 关闭 / 卸载时必须**发一条空列表**把旧矩形清掉，
 * 否则宿主会一直拿上一次的矩形做命中判定（隐藏前的位置变成幽灵热区）。
 */

import {PET_HITBOX_EVENT} from '../services/window.service';

/** 本体（精灵）的可交互区域 id：宿主还用它当「看向哪里 / 走动的基准」 */
export const BODY_HIT_AREA_ID = 'sprite';

export interface HitArea {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface HitAreaPayload {
    rects: HitArea[];
    body: HitArea | null;
}

interface Registration {
    /** 量出当前矩形；元素还没挂载/隐藏时返回 `null` */
    measure: () => HitArea | null;
}

const registrations = new Map<string, Registration>();
/** 上一次真正发出去的内容（空列表也有自己的 key，变了才会再发） */
let lastKey = '';
let pending = false;
/** 待发的「清空」请求：隐藏/卸载时置位，下一次微任务一定发空列表 */
let pendingEmpty = false;

/** 元素当前在窗口里的矩形（CSS 像素）；隐藏或还没布局时返回 `null` */
export function elementRect(element: Element | null): HitArea | null {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
    };
}

/** 一组矩形的去重 key（空列表用固定值，保证「有 → 空」一定会发一次事件） */
export function hitAreaKey(rects: HitArea[]): string {
    if (rects.length === 0) return 'empty';
    return rects.map((rect) => `${rect.x},${rect.y},${rect.width},${rect.height}`).join('|');
}

/** 组装上报载荷（纯函数：空列表时 body 也必须是 null） */
export function hitAreaPayload(rects: HitArea[], body: HitArea | null = null): HitAreaPayload {
    return {rects, body: rects.length === 0 ? null : body};
}

/** 登记一块可交互区域（同 id 覆盖）；返回注销函数 */
export function registerHitArea(id: string, measure: () => HitArea | null): () => void {
    registrations.set(id, {measure});
    publishHitAreas();
    return () => {
        if (registrations.get(id)?.measure !== measure) return;
        registrations.delete(id);
        publishHitAreas();
    };
}

/** 便捷：按元素登记（元素被移除/隐藏后自动跳过） */
export function registerHitAreaElement(id: string, getElement: () => Element | null): () => void {
    return registerHitArea(id, () => elementRect(getElement()));
}

/**
 * 重新量并上报（渲染循环里每帧调一次也很便宜：没变化不会发事件）。
 *
 * @param empty 传 `true` 表示「现在没有任何可交互区域」（窗口隐藏 / 卸载）：
 *              不看登记表，直接发空列表清掉宿主那边的旧矩形。
 */
export function publishHitAreas(empty = false): void {
    if (empty) pendingEmpty = true;
    if (pending) return;
    pending = true;
    void Promise.resolve().then(() => {
        pending = false;
        const cleared = pendingEmpty;
        pendingEmpty = false;
        const rects: HitArea[] = [];
        let body: HitArea | null = null;
        if (!cleared) {
            for (const [id, registration] of registrations) {
                const area = registration.measure();
                if (!area) continue;
                rects.push(area);
                /* 宿主用「精灵本体中心」算看向方向 / 走动的基准：窗口里有 HUD 预留，
                   窗口中心不等于本体中心 */
                if (id === BODY_HIT_AREA_ID) body = area;
            }
        }
        const key = hitAreaKey(rects);
        if (key === lastKey) return;
        lastKey = key;
        const payload = hitAreaPayload(rects, body);
        void import('@tauri-apps/api/event')
            .then(({emit}) => emit(PET_HITBOX_EVENT, payload))
            .catch(() => undefined);
    });
}

/** 清空登记并让宿主立刻穿透（测试 / 热重载 / 窗口卸载用） */
export function clearHitAreas(): void {
    registrations.clear();
    lastKey = '';
    publishHitAreas(true);
}
