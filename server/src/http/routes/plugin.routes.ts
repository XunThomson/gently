/**
 * 音源插件路由（plugin）：市场列表、安装/卸载、更新检查、配置读写。
 *
 * 两个设计要点：
 *  1. 安装/卸载是**幂等**的：桌面端重试与用户连点很常见，重复安装必须落到同一结果；
 *  2. 配置带 `revision`，走乐观并发：客户端提交旧 revision 时返回 409 `common.conflict`，
 *     由客户端拉取最新配置后重新合并，而不是让后写请求静默覆盖别人的修改。
 */
import {z} from 'zod';
import {
    pluginConfigSchema,
    pluginInstallRequestSchema,
    pluginSummarySchema,
} from '../../contracts/models.js';
import {errorResultSchema, pageQuerySchema, pageSchema, resultSchema} from '../../contracts/primitives.js';
import type {GentlyInstance} from '../instance.js';
import {notImplementedHandler} from '../result.js';

/** 卸载请求只认 id：版本由服务端决定，避免客户端指定一个已被撤回的版本 */
const uninstallRequestSchema = z.object({id: z.string()});

/** 卸载结果回显 id，便于离线队列按 id 对账 */
const uninstallResultSchema = z.object({id: z.string(), removed: z.literal(true)});

/** 路径参数：插件 id（各域统一形状，保证同样的错误信息） */
const pluginIdParamsSchema = z.object({id: z.string().min(1)});

export async function registerPluginRoutes(app: GentlyInstance): Promise<void> {
    app.get(
        '/v1/plugins',
        {
            schema: {
                operationId: 'plugin.list',
                tags: ['plugin'],
                summary: '插件市场列表（含健康状态）',
                security: [{bearerAuth: []}],
                querystring: pageQuerySchema,
                response: {
                    200: resultSchema(pageSchema(pluginSummarySchema)),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: app.deps.requireAuth,
        },
        notImplementedHandler,
    );

    app.post(
        '/v1/plugins/install',
        {
            schema: {
                operationId: 'plugin.install',
                tags: ['plugin'],
                summary: '安装插件（需显式确认）',
                security: [{bearerAuth: []}],
                body: pluginInstallRequestSchema,
                response: {
                    200: resultSchema(pluginSummarySchema),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('plugin.install')],
        },
        notImplementedHandler,
    );

    app.post(
        '/v1/plugins/uninstall',
        {
            schema: {
                operationId: 'plugin.uninstall',
                tags: ['plugin'],
                summary: '卸载插件',
                security: [{bearerAuth: []}],
                body: uninstallRequestSchema,
                response: {
                    200: resultSchema(uninstallResultSchema),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('plugin.uninstall')],
        },
        notImplementedHandler,
    );

    app.post(
        '/v1/plugins/check-updates',
        {
            schema: {
                operationId: 'plugin.checkUpdates',
                tags: ['plugin'],
                summary: '检查插件更新',
                security: [{bearerAuth: []}],
                // 每次都按服务端当前清单全量比对，因此不需要请求体
                response: {
                    200: resultSchema(
                        z.object({
                            updates: z.array(
                                z.object({
                                    id: z.string(),
                                    current: z.string(),
                                    latest: z.string(),
                                }),
                            ),
                        }),
                    ),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: app.deps.requireAuth,
        },
        notImplementedHandler,
    );

    app.get(
        '/v1/plugins/:id/config',
        {
            schema: {
                operationId: 'plugin.config.get',
                tags: ['plugin'],
                summary: '读取插件配置（含 revision）',
                security: [{bearerAuth: []}],
                params: pluginIdParamsSchema,
                response: {
                    200: resultSchema(pluginConfigSchema),
                    401: errorResultSchema,
                    404: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: app.deps.requireAuth,
        },
        notImplementedHandler,
    );

    app.post(
        '/v1/plugins/:id/config',
        {
            schema: {
                operationId: 'plugin.config.put',
                tags: ['plugin'],
                summary: '写入插件配置（乐观并发）',
                security: [{bearerAuth: []}],
                params: pluginIdParamsSchema,
                body: pluginConfigSchema,
                response: {
                    200: resultSchema(pluginConfigSchema),
                    401: errorResultSchema,
                    404: errorResultSchema,
                    // revision 落后于服务端：客户端需拉最新配置重新合并
                    409: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('plugin.config.put')],
        },
        notImplementedHandler,
    );
}
