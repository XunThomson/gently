/**
 * Redis 连接（缓存 / 幂等键 / 限流的共享底座）。
 *
 * 与数据库同样的取舍：未配置 `REDIS_URL` 时降级为 `kind: 'memory'`，
 * 服务照常启动；`/ready` 会标记 degraded，幂等与队列退化为单实例实现。
 */
import type {FastifyBaseLogger} from 'fastify';
import {Redis} from 'ioredis';
import type {AppEnv} from '../../config/env.js';

export interface CacheClient {
    readonly kind: 'redis' | 'memory';
    /** 已连接客户端；未配置时为 undefined */
    readonly redis: Redis | undefined;
    healthy(): Promise<boolean>;
    close(): Promise<void>;
}

export function createCache(env: AppEnv, logger?: FastifyBaseLogger): CacheClient {
    if (!env.hasRedis || !env.REDIS_URL) {
        logger?.warn('未配置 REDIS_URL：缓存/幂等/队列降级为进程内实现');
        return {
            kind: 'memory',
            redis: undefined,
            healthy: async () => false,
            close: async () => undefined,
        };
    }

    const redis = new Redis(env.REDIS_URL, {
        // 连不上时快速失败，不要让请求一直挂着
        maxRetriesPerRequest: 2,
        connectTimeout: 5_000,
        lazyConnect: false,
        enableOfflineQueue: false,
        retryStrategy: (times) => Math.min(times * 200, 5_000),
    });

    redis.on('error', (err) => logger?.error({err}, 'redis error'));

    return {
        kind: 'redis',
        redis,
        async healthy() {
            try {
                return (await redis.ping()) === 'PONG';
            } catch {
                return false;
            }
        },
        async close() {
            // quit 会等待待发命令；连接已断开时直接断开，避免关闭流程卡住
            try {
                await redis.quit();
            } catch {
                redis.disconnect();
            }
        },
    };
}
