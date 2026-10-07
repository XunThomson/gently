/**
 * 幂等：写操作的 `Idempotency-Key` 支持。
 *
 * 断网重试、用户连点、桌面端离线队列重放都会造成重复写；
 * 约定「同一 key 的第二次请求直接返回首次结果」，业务实现无需关心重试。
 *
 * 存储优先用 Redis（多实例一致），未配置 Redis 时降级为进程内 Map
 * （单实例开发足够，多实例下会失效——这一点在 `/ready` 的输出里会体现）。
 */
import type {FastifyReply, FastifyRequest, preHandlerHookHandler} from 'fastify';
import type {Redis} from 'ioredis';
import {ApiError} from './errors.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const DEFAULT_TTL_SEC = 24 * 60 * 60;

export type StoredResponse = {status: number; body: unknown};

export interface IdempotencyStore {
    /** 读取首次响应；未命中返回 null */
    get(scope: string, key: string): Promise<StoredResponse | null>;
    /** 记录首次响应 */
    put(scope: string, key: string, response: StoredResponse): Promise<void>;
    /** 存储实现名，用于 /ready 展示 */
    readonly kind: 'redis' | 'memory';
}

/** 进程内实现：带 TTL 清理，避免长跑进程内存增长 */
export function createMemoryIdempotencyStore(ttlSec = DEFAULT_TTL_SEC): IdempotencyStore {
    const map = new Map<string, {expireAt: number; value: StoredResponse}>();

    const sweep = (): void => {
        const now = Date.now();
        for (const [k, v] of map) {
            if (v.expireAt <= now) map.delete(k);
        }
    };

    return {
        kind: 'memory',
        async get(scope, key) {
            sweep();
            return map.get(`${scope}:${key}`)?.value ?? null;
        },
        async put(scope, key, response) {
            sweep();
            map.set(`${scope}:${key}`, {expireAt: Date.now() + ttlSec * 1000, value: response});
        },
    };
}

/** Redis 实现：键带 TTL，值序列化为 JSON */
export function createRedisIdempotencyStore(redis: Redis, ttlSec = DEFAULT_TTL_SEC): IdempotencyStore {
    return {
        kind: 'redis',
        async get(scope, key) {
            const raw = await redis.get(`gently:idem:${scope}:${key}`);
            if (raw === null) return null;
            try {
                return JSON.parse(raw) as StoredResponse;
            } catch {
                // 值损坏时按未命中处理，让请求继续而不是直接失败
                return null;
            }
        },
        async put(scope, key, response) {
            await redis.set(`gently:idem:${scope}:${key}`, JSON.stringify(response), 'EX', ttlSec);
        },
    };
}

/** 按端点清单的 `idempotent` 标记要求请求头，并在重放时直接返回首次响应 */
export function createIdempotencyGuard(store: IdempotencyStore, scope: string): preHandlerHookHandler {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const key = request.headers[IDEMPOTENCY_HEADER];
        if (typeof key !== 'string' || key.length < 8) {
            throw ApiError.invalidArgument(`该接口需要 ${IDEMPOTENCY_HEADER} 请求头（≥8 字符）`);
        }
        const cached = await store.get(scope, key);
        if (cached) {
            reply.header('Idempotency-Replayed', 'true');
            return reply.status(cached.status).send(cached.body);
        }

        // 记录首次响应：包装 reply.send 以拿到最终 body。
        // （reply 是每请求对象，这里只在当前请求上挂属性，不影响其它请求。）
        reply.header('Idempotency-Key', key);
        const originalSend = reply.send.bind(reply);
        reply.send = ((payload?: unknown) => {
            void store.put(scope, key, {status: reply.statusCode, body: payload});
            return originalSend(payload as never);
        }) as FastifyReply['send'];
    };
}
