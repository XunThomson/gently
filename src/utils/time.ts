/**
 * 定时器与资源管理工具集
 *
 * 基于所有权机制，安全地管理 setTimeout / setInterval / requestAnimationFrame
 * 以及可延长的自定义定时器，避免组件卸载后回调仍执行导致的内存泄漏。
 *
 * 设计要点：
 * - 单调时钟：使用 performance.now() 作为截止时间基准，免受系统时钟调整影响
 * - 所有权令牌：每次 prolong 后旧令牌失效，用于校验操作权限
 * - 惰性兜底：safeExecute 的 fallback 采用惰性求值，避免错误路径外的副作用
 * - 重入安全：clean/cleanup 先摘除快照再执行清理回调
 * - 原型隔离：标签使用 Object.create(null) + freeze，阻断原型链污染
 * - 类型防御：非法过滤器不再降级为「匹配全部」，避免误清理
 * - 环境降级：不支持 rAF 的宿主环境安全 no-op，不抛 ReferenceError
 */

// ============================================================
// 类型定义
// ============================================================

/** 简单资源的清理函数 */
export type CleanupFn = () => void

/** 所有权令牌：每次 prolong 后旧令牌失效，用于校验操作权限 */
export type OwnershipToken = number

/** 资源标签，用于分类与筛选 */
export type CleanupTags = Record<string, unknown>

/** 过滤器：标签键名 / 标签键值对 / 自定义函数 */
export type CleanupFilter =
    | string
    | CleanupTags
    | ((entry: { tags?: CleanupTags }) => boolean)

export interface ProlongableTimeoutHandle {
    /** 使用指定令牌清理定时器；令牌不匹配或已结束返回 false */
    cleanup(token: OwnershipToken): boolean

    /**
     * 延长定时器。
     * @param additionalMs 增加的毫秒数
     * @param forceInterrupt 为 true 时丢弃剩余时间，从 additionalMs 重新倒计时
     * @returns [是否成功, 新令牌]；失败或已结束时新令牌为 null
     */
    prolong(
        additionalMs: number,
        forceInterrupt?: boolean,
    ): [success: boolean, token: OwnershipToken | null]

    /** 当前有效令牌 */
    readonly currentToken: OwnershipToken

    /** 当前是否仍然有效：未取消且未执行 */
    readonly isActive: boolean
}

export interface ResourceCleaner {
    add(fn: CleanupFn, tags?: CleanupTags): void
    addProlongable(handle: ProlongableTimeoutHandle, tags?: CleanupTags): void
    createAndAddProlongable(
        callback: () => void,
        delay: number,
        tags?: CleanupTags,
    ): ProlongableTimeoutHandle

    /** 执行全部清理并清空管理器 */
    cleanup(): void
    /** 按过滤器清理，返回清理数量 */
    clean(filter: CleanupFilter): number
    /** 按过滤器统计数量 */
    count(filter: CleanupFilter): number
    /** 当前资源总数 */
    size(): number
    /** 是否存在匹配资源 */
    has(filter: CleanupFilter): boolean
    /** 延长第一个匹配的可延长定时器 */
    prolong(filter: CleanupFilter, additionalMs: number, forceInterrupt?: boolean): boolean
}

export interface TimerManager extends ResourceCleaner {
    setTimeout(callback: () => void, delay: number, tags?: CleanupTags): CleanupFn
    setInterval(callback: () => void, interval: number, tags?: CleanupTags): CleanupFn
    requestAnimationFrame(
        callback: (timestamp: number) => void,
        tags?: CleanupTags,
    ): CleanupFn
}

// ============================================================
// 内部工具
// ============================================================

/** 浏览器 / Node 中 setTimeout 的最大安全延时 */
const MAX_TIMEOUT = 2_147_483_647

/**
 * 单调时钟：优先使用 performance.now()，避免系统时间被调整时
 * Date.now() 造成的定时器提前触发 / 永不触发。
 */
const monotonicNow: () => number =
    typeof globalThis.performance !== 'undefined' &&
    typeof globalThis.performance.now === 'function'
        ? () => globalThis.performance.now()
        : () => Date.now()

/**
 * 安全执行包装。
 *
 * 注意：fallback 采用【惰性求值】——只有错误路径才构造回退值，
 * 避免在正常路径上产生副作用（例如误创建定时器）。
 */
function safeExecute<T>(
    fn: () => T,
    fallback: () => T,
    errorMessage: string,
): T {
    try {
        return fn()
    } catch (error) {
        console.error(errorMessage, error)
        return fallback()
    }
}

/** 归一化延时：非有限数归零，负数归零，向下取整，并限制在最大安全值内 */
function normalizeDelay(delay: number): number {
    if (!Number.isFinite(delay)) return 0
    return Math.min(Math.max(0, Math.floor(delay)), MAX_TIMEOUT)
}

/** 仅检查自有属性，避免原型链污染与原型键误匹配 */
function hasOwn(obj: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(obj, key)
}

/** 危险键集合：阻止原型污染通过标签对象进入 */
const FORBIDDEN_TAG_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * 复制标签为无原型对象并冻结，隔离外部可变引用与原型链风险。
 *
 * 加固点：
 * - 显式拒绝数组，避免索引键被误识别为标签
 * - 跳过 __proto__ / constructor / prototype，双重保险
 * - try/catch 防护带副作用的 getter，失败时放弃整个标签包而不是冒泡
 *
 * 注意：此处仅做浅拷贝，标签值若为对象仍可能被外部修改；
 * 若需强隔离，调用方应对嵌套值自行做深拷贝。
 */
function sanitizeTags(tags?: CleanupTags): CleanupTags | undefined {
    if (tags == null || typeof tags !== 'object' || Array.isArray(tags)) {
        return undefined
    }

    const result = Object.create(null) as CleanupTags
    try {
        for (const key of Object.keys(tags)) {
            if (FORBIDDEN_TAG_KEYS.has(key)) continue
            result[key] = tags[key]
        }
    } catch (error) {
        console.warn('Failed to read tags; ignoring tag bag.', error)
        return undefined
    }

    return Object.freeze(result) as CleanupTags
}

// ============================================================
// 基础资源创建
// ============================================================

/**
 * 创建一个可清理的 setTimeout
 * @example
 * const cancel = createTimeout(() => console.log('hi'), 1000)
 * cancel()
 */
export function createTimeout(callback: () => void, delay: number): CleanupFn {
    if (typeof callback !== 'function') {
        console.warn('createTimeout expects a function callback; ignoring.')
        return () => {}
    }
    const id = setTimeout(callback, normalizeDelay(delay))
    return () => clearTimeout(id)
}

/**
 * 创建一个可清理的 setInterval
 */
export function createInterval(callback: () => void, interval: number): CleanupFn {
    if (typeof callback !== 'function') {
        console.warn('createInterval expects a function callback; ignoring.')
        return () => {}
    }
    const id = setInterval(callback, normalizeDelay(interval))
    return () => clearInterval(id)
}

/**
 * 创建一个可清理的 requestAnimationFrame 循环。
 *
 * 处理了「在回调中调用 cancel」的竞态：即使取消发生在当前帧回调中，
 * 也不会再排入下一帧。
 *
 * 在 SSR / Node 等不支持 rAF 的宿主环境中安全降级为 no-op，
 * 避免直接抛 ReferenceError。
 */
export function createRafLoop(callback: (timestamp: number) => void): CleanupFn {
    if (typeof callback !== 'function') {
        console.warn('createRafLoop expects a function callback; ignoring.')
        return () => {}
    }

    const raf =
        typeof globalThis.requestAnimationFrame === 'function'
            ? globalThis.requestAnimationFrame.bind(globalThis)
            : null
    const caf =
        typeof globalThis.cancelAnimationFrame === 'function'
            ? globalThis.cancelAnimationFrame.bind(globalThis)
            : null

    if (raf === null || caf === null) {
        console.warn('requestAnimationFrame is unavailable; RAF loop disabled.')
        return () => {}
    }

    let rafId: number | null = null
    let cancelled = false

    const loop = (timestamp: number) => {
        if (cancelled) return

        safeExecute(
            () => callback(timestamp),
            () => undefined,
            'Error in RAF callback',
        )

        if (cancelled) return
        rafId = raf(loop)
    }

    rafId = raf(loop)

    return () => {
        if (cancelled) return
        cancelled = true

        if (rafId !== null) {
            caf(rafId)
            rafId = null
        }
    }
}

// ============================================================
// 可延长定时器
// ============================================================

/**
 * 一个永远 inactive 的空 handle，用作创建失败时的兜底。
 * 注意：不产生任何定时器，避免错误路径上的资源泄漏。
 */
function createInactiveHandle(): ProlongableTimeoutHandle {
    return {
        cleanup: () => false,
        prolong: (): [boolean, OwnershipToken | null] => [false, null],
        currentToken: 0,
        isActive: false,
    }
}

/**
 * 创建带所有权校验、可延长的超时定时器。
 *
 * 内部使用「绝对截止时间 deadline」而非「剩余毫秒数」，避免累加时把已流逝时间算进去。
 * 时钟源使用单调时钟（performance.now），不受系统时间调整影响。
 *
 * @example
 * const h = createProlongableTimeout(() => console.log('done'), 5000)
 * const [ok, token] = h.prolong(2000)          // 剩余时间 +2s
 * h.cleanup(h.currentToken)                     // 用最新令牌清理
 */
export function createProlongableTimeout(
    callback: () => void,
    delay: number,
): ProlongableTimeoutHandle {
    if (typeof callback !== 'function') {
        console.warn(
            'createProlongableTimeout expects a function callback; returning inactive handle.',
        )
        return createInactiveHandle()
    }

    let timerId: ReturnType<typeof setTimeout> | null = null
    let deadline = monotonicNow() + normalizeDelay(delay)
    let isCancelled = false
    let isExecuted = false
    let currentToken: OwnershipToken = 0
    let nextTokenId = 1

    const clearTimer = () => {
        if (timerId !== null) {
            clearTimeout(timerId)
            timerId = null
        }
    }

    const executeCallback = () => {
        if (isCancelled || isExecuted) return

        isExecuted = true
        isCancelled = true
        clearTimer()

        safeExecute(
            callback,
            () => undefined,
            'Error executing prolonged timeout callback',
        )
    }

    const schedule = () => {
        clearTimer()
        if (isCancelled || isExecuted) return

        const remaining = deadline - monotonicNow()
        const wait = remaining <= 0 ? 0 : Math.min(remaining, MAX_TIMEOUT)

        try {
            timerId = setTimeout(() => {
                // 定时器已触发，先清空 id，避免后续 clearTimer 处理陈旧 id
                timerId = null
                if (isCancelled || isExecuted) return

                // 处理超过 setTimeout 最大值的长延时：未到截止时间则继续排程
                if (monotonicNow() < deadline) {
                    schedule()
                    return
                }

                executeCallback()
            }, wait)
        } catch (error) {
            // 排程失败：标记为终止，避免 isActive 永久为 true 造成泄漏
            console.error('Failed to schedule prolonged timeout', error)
            timerId = null
            isCancelled = true
        }
    }

    schedule()

    return {
        cleanup(token) {
            return safeExecute(
                () => {
                    if (token !== currentToken) {
                        console.warn('Cleanup failed: invalid ownership token.')
                        return false
                    }
                    if (isCancelled || isExecuted) return false

                    clearTimer()
                    isCancelled = true
                    return true
                },
                () => false,
                'Error during prolonged timeout cleanup',
            )
        },

        prolong(additionalMs, forceInterrupt = false): [boolean, OwnershipToken | null] {
            return safeExecute(
                (): [boolean, OwnershipToken | null] => {
                    // 参数校验：非有限数或负数视为无效
                    if (!Number.isFinite(additionalMs) || additionalMs < 0) {
                        return [false, null]
                    }

                    if (isCancelled || isExecuted) return [false, null]

                    const ms = Math.floor(additionalMs)
                    const nowTs = monotonicNow()

                    if (forceInterrupt) {
                        deadline = nowTs + ms
                    } else {
                        // 在尚未过期的截止时间上累加；已过期则从当前时间重新计算
                        deadline = Math.max(deadline, nowTs) + ms
                    }

                    currentToken = nextTokenId++
                    schedule()
                    return [true, currentToken]
                },
                () => [false, null] as [boolean, OwnershipToken | null],
                'Error during timeout prolong',
            )
        },

        get currentToken() {
            return currentToken
        },

        get isActive() {
            return !isCancelled && !isExecuted
        },
    }
}

// ============================================================
// 防抖 / 节流
// ============================================================

/**
 * 防抖：在 `wait` 毫秒内的多次调用只执行最后一次。
 * 附带 `cancel()` 与 `flush()`。
 */
export function debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number,
): ((...args: Parameters<T>) => void) & { cancel: () => void; flush: () => void } {
    const waitMs = normalizeDelay(wait)

    let timeout: ReturnType<typeof setTimeout> | null = null
    let lastArgs: Parameters<T> | null = null
    let lastThis: ThisParameterType<T> | null = null

    const invoke = () => {
        timeout = null
        if (!lastArgs) return

        const args = lastArgs
        const ctx = lastThis
        lastArgs = null
        lastThis = null

        safeExecute(
            () => func.apply(ctx, args),
            () => undefined,
            'Error in debounced function execution',
        )
    }

    const debounced = function (this: ThisParameterType<T>, ...args: Parameters<T>) {
        lastThis = this
        lastArgs = args
        if (timeout !== null) clearTimeout(timeout)
        timeout = setTimeout(invoke, waitMs)
    }

    debounced.cancel = () => {
        if (timeout === null) return
        clearTimeout(timeout)
        timeout = null
        lastArgs = null
        lastThis = null
    }

    debounced.flush = () => {
        if (timeout === null) return
        clearTimeout(timeout)
        // timeout 已置空，交由 invoke 内部统一清理 lastArgs / lastThis
        invoke()
    }

    return debounced
}

/**
 * 节流：`limit` 毫秒内最多执行一次（首次立即执行，尾部保留最后一次调用）。
 * 附带 `cancel()`。
 */
export function throttle<T extends (...args: any[]) => any>(
    func: T,
    limit: number,
): ((...args: Parameters<T>) => void) & { cancel: () => void } {
    const limitMs = normalizeDelay(limit)

    let inThrottle = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let lastArgs: Parameters<T> | null = null
    let lastThis: ThisParameterType<T> | null = null

    const invokeTrailing = () => {
        inThrottle = false
        timeout = null
        if (lastArgs) {
            const args = lastArgs
            const ctx = lastThis
            lastArgs = null
            lastThis = null
            safeExecute(
                () => func.apply(ctx, args),
                () => undefined,
                'Error in throttled function execution',
            )
        }
    }

    const throttled = function (this: ThisParameterType<T>, ...args: Parameters<T>) {
        if (!inThrottle) {
            safeExecute(
                () => func.apply(this, args),
                () => undefined,
                'Error in throttled function execution',
            )
            inThrottle = true
            timeout = setTimeout(invokeTrailing, limitMs)
        } else {
            lastArgs = args
            lastThis = this
        }
    }

    throttled.cancel = () => {
        if (timeout === null) return
        clearTimeout(timeout)
        timeout = null
        inThrottle = false
        lastArgs = null
        lastThis = null
    }

    return throttled
}

// ============================================================
// 统一资源管理器
// ============================================================

/**
 * 创建统一资源清理器。
 *
 * @example
 * const cleaner = createResourceCleaner()
 * cleaner.add(createTimeout(() => {}, 1000), { type: 'normal' })
 *
 * const task = cleaner.createAndAddProlongable(() => {}, 5000, { id: 'taskA' })
 * cleaner.prolong({ id: 'taskA' }, 2000)
 *
 * cleaner.cleanup()
 */
export function createResourceCleaner(): ResourceCleaner {
    type SimpleEntry = {
        type: 'simple'
        fn: CleanupFn
        tags?: CleanupTags
    }
    type ProlongableEntry = {
        type: 'prolongable'
        handle: ProlongableTimeoutHandle
        tags?: CleanupTags
    }
    type Entry = SimpleEntry | ProlongableEntry

    const entries: Entry[] = []

    /**
     * 将过滤器编译为可复用的谓词函数。
     *
     * 类型防御：非法过滤器类型（number / boolean / symbol / 数组）一律
     * 返回「永不匹配」的谓词，防止被静默降级为空对象而误清全部资源。
     */
    const makePredicate = (filter: CleanupFilter): ((entry: Entry) => boolean) => {
        if (filter == null) return () => false

        if (typeof filter === 'function') {
            // 仅向过滤器暴露 { tags }，避免其篡改内部 entry
            return (entry) =>
                safeExecute(
                    () => Boolean(filter({ tags: entry.tags })),
                    () => false,
                    'Error in cleanup filter',
                )
        }

        if (typeof filter === 'string') {
            const key = filter
            return (entry) => {
                const tags = entry.tags
                // 仅匹配自有属性，且以「键存在」为准（不因值为 0 / '' / false 而漏配）
                return Boolean(tags && hasOwn(tags, key))
            }
        }

        // 非法过滤器类型：不匹配任何资源，避免意外清空
        if (typeof filter !== 'object' || Array.isArray(filter)) {
            console.warn(
                'Unsupported cleanup filter type; nothing will match:',
                typeof filter,
            )
            return () => false
        }

        const tagFilters =
            sanitizeTags(filter) ??
            (Object.freeze(Object.create(null)) as CleanupTags)

        const keys = Object.keys(tagFilters)

        return (entry) => {
            if (keys.length === 0) return true

            const tags = entry.tags
            if (!tags) return false

            return keys.every((k) => hasOwn(tags, k) && tags[k] === tagFilters[k])
        }
    }

    /** 清理已失效的 prolongable 条目（已取消 / 已执行 / 被外部清理） */
    const pruneInactive = () => {
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i]
            if (e.type === 'prolongable' && !e.handle.isActive) {
                entries.splice(i, 1)
            }
        }
    }

    /** 执行单个条目的清理动作 */
    const disposeEntry = (entry: Entry) => {
        safeExecute(
            () => {
                if (entry.type === 'simple') {
                    entry.fn()
                    return
                }

                if (entry.handle.isActive) {
                    // 始终使用最新令牌，避免外部 prolong 后管理器持有的令牌失效
                    entry.handle.cleanup(entry.handle.currentToken)
                }
            },
            () => undefined,
            'Error during cleanup execution',
        )
    }

    const add = (fn: CleanupFn, tags?: CleanupTags) => {
        safeExecute(
            () => {
                if (typeof fn !== 'function') {
                    console.warn('add() expects a function; ignoring.')
                    return
                }
                entries.push({
                    type: 'simple',
                    fn,
                    tags: sanitizeTags(tags),
                })
            },
            () => undefined,
            'Error adding simple resource',
        )
    }

    const addProlongable = (handle: ProlongableTimeoutHandle, tags?: CleanupTags) => {
        safeExecute(
            () => {
                if (!handle || !handle.isActive) return

                entries.push({
                    type: 'prolongable',
                    handle,
                    tags: sanitizeTags(tags),
                })
            },
            () => undefined,
            'Error adding prolongable resource',
        )
    }

    const createAndAddProlongable = (
        callback: () => void,
        delay: number,
        tags?: CleanupTags,
    ): ProlongableTimeoutHandle => {
        // fallback 惰性求值，且不产生“幽灵定时器”
        const handle = safeExecute(
            () => createProlongableTimeout(callback, delay),
            () => createInactiveHandle(),
            'Error creating prolongable timeout',
        )

        addProlongable(handle, tags)
        return handle
    }

    return {
        add,
        addProlongable,
        createAndAddProlongable,

        cleanup() {
            // 先摘除快照，避免清理回调中再次 add/clean/cleanup 破坏遍历
            const snapshot = entries.splice(0, entries.length)
            for (const entry of snapshot) disposeEntry(entry)
        },

        clean(filter) {
            const match = makePredicate(filter)

            // 先拍快照：用户过滤器可重入调用 cleanup/clean 篡改 entries
            const snapshot = entries.slice()
            const toDispose: Entry[] = []

            for (const entry of snapshot) {
                const isMatch = safeExecute(
                    () => match(entry),
                    () => false,
                    'Error in cleanup filter',
                )
                if (isMatch) toDispose.push(entry)
            }

            // 用 Set 做差集删除，避免遍历与重入修改之间产生错位
            if (toDispose.length > 0) {
                const removeSet = new Set<Entry>(toDispose)
                for (let i = entries.length - 1; i >= 0; i--) {
                    if (removeSet.has(entries[i])) entries.splice(i, 1)
                }
            }

            for (const entry of toDispose) disposeEntry(entry)

            pruneInactive()
            return toDispose.length
        },

        count(filter) {
            const match = makePredicate(filter)
            pruneInactive()

            let n = 0
            for (const e of entries) {
                if (match(e)) n++
            }
            return n
        },

        size() {
            pruneInactive()
            return entries.length
        },

        has(filter) {
            const match = makePredicate(filter)
            pruneInactive()
            return entries.some(match)
        },

        prolong(filter, additionalMs, forceInterrupt = false) {
            if (!Number.isFinite(additionalMs) || additionalMs < 0) {
                return false
            }

            const match = makePredicate(filter)
            pruneInactive()

            const idx = entries.findIndex(
                (e) => e.type === 'prolongable' && e.handle.isActive && match(e),
            )
            if (idx === -1) return false

            const entry = entries[idx] as ProlongableEntry

            const [ok, newToken] = safeExecute(
                () => entry.handle.prolong(additionalMs, Boolean(forceInterrupt)),
                () => [false, null] as [boolean, OwnershipToken | null],
                'Error during prolong operation',
            )

            if (ok && newToken !== null) return true

            pruneInactive()
            return false
        },
    }
}

// ============================================================
// 便捷封装：TimerManager
// ============================================================

/**
 * 在 ResourceCleaner 基础上，额外提供与原生 API 同名的定时器创建方法。
 */
export function createTimerManager(): TimerManager {
    const cleaner = createResourceCleaner()

    return {
        ...cleaner,

        setTimeout(callback, delay, tags) {
            const cancel = createTimeout(callback, delay)
            cleaner.add(cancel, tags)
            return cancel
        },

        setInterval(callback, interval, tags) {
            const cancel = createInterval(callback, interval)
            cleaner.add(cancel, tags)
            return cancel
        },

        requestAnimationFrame(callback, tags) {
            const cancel = createRafLoop(callback)
            cleaner.add(cancel, tags)
            return cancel
        },
    }
}

// ============================================================
// 默认导出
// ============================================================

export default {
    createTimeout,
    createInterval,
    createRafLoop,
    createProlongableTimeout,
    debounce,
    throttle,
    createResourceCleaner,
    createTimerManager,
}