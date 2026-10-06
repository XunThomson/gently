import type { ReactNode } from 'react';
import type { Aspect, AspectPayload } from '../types';

const aspectStore = new Map<string, Aspect[]>();

export function registerAspect(aspect: Aspect): void {
    if (!aspect || !aspect.point || typeof aspect.advice !== 'function') {
        console.warn('[AOP] 非法的切面定义：', aspect);
        return;
    }
    const list = aspectStore.get(aspect.point) ?? [];
    const i = list.findIndex((a) => a.id === aspect.id);
    if (i >= 0) list.splice(i, 1);
    list.push(aspect);
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    aspectStore.set(aspect.point, list);
}

export function registerAspects(list: Aspect[] = []): void {
    list.forEach(registerAspect);
}

export function getAspects(point: string): Aspect[] {
    return aspectStore.get(point) ?? [];
}

/**
 * 洋葱模型执行：切面可通过 next() 继续向内，最终抵达 fallback（默认实现）。
 */
export function runAspects<R>(
    point: string,
    payload: AspectPayload,
    fallback: (p: AspectPayload) => R,
): R {
    const active = payload.viewCtx?.activeAspects;
    const chain = getAspects(point).filter((a) => !active || active.has(a.id));

    let cursor = -1;
    function dispatch(i: number): R {
        if (i <= cursor) {
            throw new Error(`[AOP] 切点 "${point}" 的 next() 被重复调用`);
        }
        cursor = i;
        const aspect = chain[i];
        if (!aspect) return fallback(payload);
        return aspect.advice(payload, () => dispatch(i + 1)) as R;
    }
    return dispatch(0);
}

export type { AspectPayload };