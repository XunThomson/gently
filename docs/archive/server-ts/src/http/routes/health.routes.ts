/**
 * 探针端点（**已实现**，属于基础设施而非业务）。
 *
 * - `/health`：存活探针，只回答「进程还在不在」，不触碰外部依赖；
 * - `/ready`：就绪探针，报告各依赖状态。
 *   规则：**已配置但不可用** → 503（编排系统应摘流量）；
 *        **未配置** → 200 + `degraded`（骨架阶段允许无 Postgres/Redis 运行）。
 */
import type {FastifyReply, FastifyRequest} from 'fastify';
import {z} from 'zod';
import type {GentlyInstance} from '../instance.js';
import {API_VERSION} from '../swagger.js';
import {ok, requestIdOf} from '../result.js';

const dependencySchema = z.object({
    status: z.enum(['up', 'down', 'unconfigured']),
    kind: z.string().describe('实际使用的实现，如 postgres / memory'),
    detail: z.string().optional(),
});

export const healthResponseSchema = z.object({
    status: z.literal('ok'),
    version: z.string(),
    uptimeSec: z.number().int().nonnegative(),
    timestamp: z.string(),
});

export const readyResponseSchema = z.object({
    status: z.enum(['ready', 'degraded']),
    checks: z.object({
        db: dependencySchema,
        cache: dependencySchema,
        queues: dependencySchema,
        plugins: dependencySchema,
        realtime: dependencySchema,
    }),
    timestamp: z.string(),
});

export type ReadyResponse = z.infer<typeof readyResponseSchema>;

export async function registerHealthRoutes(app: GentlyInstance): Promise<void> {
    app.get(
        '/health',
        {
            schema: {
                operationId: 'health.check',
                tags: ['health'],
                summary: '存活探针：进程与版本',
                response: {200: z.object({ok: z.literal(true), data: healthResponseSchema, requestId: z.string()})},
            },
        },
        async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
            await reply.send(
                ok(
                    {
                        status: 'ok' as const,
                        version: API_VERSION,
                        uptimeSec: Math.floor((Date.now() - app.deps.startedAt) / 1000),
                        timestamp: new Date().toISOString(),
                    },
                    requestIdOf(request),
                ),
            );
        },
    );

    app.get(
        '/ready',
        {
            schema: {
                operationId: 'health.ready',
                tags: ['health'],
                summary: '就绪探针：依赖连通性（未配置的依赖记为 unconfigured）',
                response: {200: z.object({ok: z.literal(true), data: readyResponseSchema, requestId: z.string()})},
            },
        },
        async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
            const {db, cache, queues, plugins, realtime} = app.deps;

            const dbUp = await db.healthy();
            const cacheUp = await cache.healthy();

            const checks: ReadyResponse['checks'] = {
                db: {
                    status: db.kind === 'none' ? 'unconfigured' : dbUp ? 'up' : 'down',
                    kind: db.kind,
                    ...(db.kind === 'none' ? {detail: '未配置 DATABASE_URL'} : {}),
                },
                cache: {
                    status: cache.kind === 'memory' ? 'unconfigured' : cacheUp ? 'up' : 'down',
                    kind: cache.kind,
                    ...(cache.kind === 'memory' ? {detail: '未配置 REDIS_URL'} : {}),
                },
                queues: {
                    status: queues.kind === 'memory' ? 'unconfigured' : 'up',
                    kind: queues.kind,
                },
                plugins: {
                    status: 'up',
                    kind: 'manifest',
                    detail: `已加载 ${plugins.size} 个插件`,
                },
                realtime: {status: 'up', kind: 'websocket', detail: `当前连接 ${realtime.connections}`},
            };

            // 只有「已配置却不可用」才算不就绪
            const broken = Object.values(checks).some((c) => c.status === 'down');
            const degraded = Object.values(checks).some((c) => c.status === 'unconfigured');

            await reply
                .status(broken ? 503 : 200)
                .send(
                    ok(
                        {
                            status: broken || degraded ? ('degraded' as const) : ('ready' as const),
                            checks,
                            timestamp: new Date().toISOString(),
                        },
                        requestIdOf(request),
                    ),
                );
        },
    );
}
