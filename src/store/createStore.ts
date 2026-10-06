import {useCallback, useRef, useSyncExternalStore} from 'react';

export type Listener = () => void;

export interface StoreApi<T extends object> {
    getState: () => T;
    /** 顶层浅合并；修改嵌套切片时请整体替换该切片对象 */
    setState: (patch: Partial<T> | ((state: T) => Partial<T>)) => void;
    subscribe: (listener: Listener) => () => void;
}

/**
 * 极简集中式 store：
 * - 无第三方依赖，基于 React 18+ 的 `useSyncExternalStore`
 * - 单一 state 树 + 浅比较订阅，保证「数据集中、传递高效」
 */
export function createStore<T extends object>(initialState: T): StoreApi<T> {
    let state = initialState;
    const listeners = new Set<Listener>();

    return {
        getState: () => state,

        setState(patch) {
            const partial =
                typeof patch === 'function' ? (patch as (s: T) => Partial<T>)(state) : patch;
            if (!partial) return;

            let changed = false;
            for (const key of Object.keys(partial) as (keyof T)[]) {
                if (!Object.is(state[key], partial[key])) {
                    changed = true;
                    break;
                }
            }
            if (!changed) return;

            state = {...state, ...partial};
            listeners.forEach((l) => l());
        },

        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

/** 浅比较：用于 selector 返回对象/数组的场景 */
export function shallowEqual<T>(a: T, b: T): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;

    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;

    for (const k of ka) {
        if (!Object.is(
            (a as Record<string, unknown>)[k],
            (b as Record<string, unknown>)[k],
        )) return false;
    }
    return true;
}

/**
 * 订阅 store 的某个切片。
 * selector 结果默认用 `Object.is` 比较；返回派生对象时传入 `shallowEqual`。
 */
export function useStore<T extends object, S>(
    store: StoreApi<T>,
    selector: (state: T) => S,
    isEqual: (a: S, b: S) => boolean = Object.is,
): S {
    const cache = useRef<{state: T; value: S} | null>(null);
    const selectorRef = useRef(selector);
    selectorRef.current = selector;
    const isEqualRef = useRef(isEqual);
    isEqualRef.current = isEqual;

    const getSnapshot = useCallback((): S => {
        const state = store.getState();
        const cached = cache.current;

        if (cached && Object.is(cached.state, state)) return cached.value;

        const value = selectorRef.current(state);
        if (cached && isEqualRef.current(cached.value, value)) {
            cache.current = {state, value: cached.value};
            return cached.value;
        }

        cache.current = {state, value};
        return value;
    }, [store]);

    return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
