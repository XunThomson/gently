/**
 * 宠物窗口的**可交互区域**（多个矩形）登记与上报。
 *
 * 为什么是「多个矩形」：宠物窗口里有两个东西应该吃鼠标——
 * 1. 精灵本体（点它 = 摸摸、拖它 = 移动窗口）；
 * 2. 顶部那条透明的拖动区。
 * 只上报精灵矩形会让拖动条失效（宿主把整窗设成点击穿透，拖动条永远收不到 pointerdown）；
 * 而把整窗都算进去，又会让透明区域挡住下面的应用。
 *
 * 上报策略：每次渲染时重新量一遍，**内容变了才**发事件（宿主只要最新值）。
 */

import {PET_HITBOX_EVENT} from '../services/window.service';

export interface HitArea {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface Registration {
    /** 量出当前矩形；元素还没挂载/隐藏时返回 `null` */
    measure: () => HitArea | null;
}

const registrations = new Map<string, Registration>();
let lastKey = '';
let pending = false;

function rectOf(element: Element | null): HitArea | null {
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

/** 便捷：按元素登记（元素被移除后自动跳过） */
export function registerHitAreaElement(id: string, getElement: () => Element | null): () => void {
    return registerHitArea(id, () => rectOf(getElement()));
}

/** 重新量并上报（渲染循环里每帧调一次也很便宜：没变化不会发事件） */
export function publishHitAreas(): void {
    if (pending) return;
    pending = true;
    void Promise.resolve().then(() => {
        pending = false;
        const rects: HitArea[] = [];
        for (const registration of registrations.values()) {
            const area = registration.measure();
            if (area) rects.push(area);
        }
        if (rects.length === 0) return;
        const key = rects.map((r) => `${r.x},${r.y},${r.width},${r.height}`).join('|');
        if (key === lastKey) return;
        lastKey = key;
        void import('@tauri-apps/api/event')
            .then(({emit}) => emit(PET_HITBOX_EVENT, {rects}))
            .catch(() => undefined);
    });
}

/** 清空登记（测试与热重载用） */
export function clearHitAreas(): void {
    registrations.clear();
    lastKey = '';
}
