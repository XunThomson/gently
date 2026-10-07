/**
 * 后台任务队列（BullMQ）。
 *
 * 用途（业务接入后填充 job 处理器，本阶段只建队列基础设施）：
 *  - `download`：下载任务推进（进度通过实时通道推送）；
 *  - `plugin-probe`：音源健康探测，结果触发 `plugin.health` 事件；
 *  - `recommend-precompute`：推荐结果预计算，降低首页首屏延迟。
 *
 * 队列需要 Redis；未配置时返回空实现，`enqueue` 抛 `source.unavailable`——
 * **明确失败**而不是静默丢弃任务。
 */
import {Queue, type JobsOptions} from 'bullmq';
import type {FastifyBaseLogger} from 'fastify';
import type {AppEnv} from '../../config/env.js';
import {ApiError} from '../../http/errors.js';

export const QUEUE_NAMES = {
    download: 'download',
    pluginProbe: 'plugin-probe',
    recommendPrecompute: 'recommend-precompute',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface QueueClient {
    readonly kind: 'redis' | 'memory';
    /** 入队；未配置 Redis 时抛 `source.unavailable` */
    enqueue(name: QueueName, jobName: string, payload: unknown, options?: JobsOptions): Promise<string>;
    /** 队列积压情况，供 /ready 与监控使用 */
    counts(name: QueueName): Promise<Record<string, number>>;
    close(): Promise<void>;
}

export function createQueues(env: AppEnv, logger?: FastifyBaseLogger): QueueClient {
    if (!env.hasRedis || !env.REDIS_URL) {
        return {
            kind: 'memory',
            async enqueue() {
                throw ApiError.sourceUnavailable('未配置 Redis，后台任务队列不可用');
            },
            async counts() {
                return {};
            },
            async close() {
                /* 无连接可关 */
            },
        };
    }

    const connection = {url: env.REDIS_URL};
    const queues = new Map<QueueName, Queue>();

    const queueOf = (name: QueueName): Queue => {
        const existing = queues.get(name);
        if (existing) return existing;
        const created = new Queue(name, {
            connection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {type: 'exponential', delay: 2_000},
                // 完成的 job 保留少量，便于排查；失败的全量保留
                removeOnComplete: {count: 100},
                removeOnFail: {count: 1_000},
            },
        });
        created.on('error', (err) => logger?.error({err, queue: name}, 'queue error'));
        queues.set(name, created);
        return created;
    };

    return {
        kind: 'redis',
        async enqueue(name, jobName, payload, options) {
            const job = await queueOf(name).add(jobName, payload, options);
            return String(job.id);
        },
        async counts(name) {
            return queueOf(name).getJobCounts() as Promise<Record<string, number>>;
        },
        async close() {
            await Promise.allSettled([...queues.values()].map((q) => q.close()));
            queues.clear();
        },
    };
}
