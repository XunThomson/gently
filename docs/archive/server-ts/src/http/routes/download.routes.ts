/**
 * 下载路由（download）：任务分页、创建、暂停/恢复、删除、清理已完成。
 *
 * 约定：
 *  - `download.create` 幂等：桌面端离线队列会在重连后重放，重复创建同一个任务
 *    会让同一首歌下载多份；幂等键命中时直接返回首次的任务快照；
 *  - 暂停 / 恢复同样是写操作，但由任务自身的状态机决定是否合法（非法转移 → 409 由业务层给出）；
 *  - `clearFinished` 返回**删除条数**，让客户端能提示「已清理 N 项」而不是盲目刷新。
 */
import {z} from 'zod';
import {downloadCreateRequestSchema, downloadTaskSchema} from '../../contracts/models.js';
import {errorResultSchema, pageQuerySchema, pageSchema, resultSchema} from '../../contracts/primitives.js';
import type {GentlyInstance} from '../instance.js';
import {notImplementedHandler} from '../result.js';

/** 路径参数：下载任务 id */
const taskIdParamsSchema = z.object({id: z.string().min(1)});

/** 删除结果回显 id，便于离线动作队列对账 */
const removeResultSchema = z.object({id: z.string(), removed: z.literal(true)});

export async function registerDownloadRoutes(app: GentlyInstance): Promise<void> {
    app.get(
        '/v1/downloads',
        {
            schema: {
                operationId: 'download.list',
                tags: ['download'],
                summary: '下载任务分页',
                security: [{bearerAuth: []}],
                querystring: pageQuerySchema,
                response: {
                    200: resultSchema(pageSchema(downloadTaskSchema)),
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
        '/v1/downloads',
        {
            schema: {
                operationId: 'download.create',
                tags: ['download'],
                summary: '创建下载任务（幂等）',
                security: [{bearerAuth: []}],
                body: downloadCreateRequestSchema,
                response: {
                    200: resultSchema(downloadTaskSchema),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('download.create')],
        },
        notImplementedHandler,
    );

    app.post(
        '/v1/downloads/:id/pause',
        {
            schema: {
                operationId: 'download.pause',
                tags: ['download'],
                summary: '暂停下载',
                security: [{bearerAuth: []}],
                params: taskIdParamsSchema,
                response: {
                    200: resultSchema(downloadTaskSchema),
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
        '/v1/downloads/:id/resume',
        {
            schema: {
                operationId: 'download.resume',
                tags: ['download'],
                summary: '恢复下载',
                security: [{bearerAuth: []}],
                params: taskIdParamsSchema,
                response: {
                    200: resultSchema(downloadTaskSchema),
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

    app.delete(
        '/v1/downloads/:id',
        {
            schema: {
                operationId: 'download.remove',
                tags: ['download'],
                summary: '删除下载任务',
                security: [{bearerAuth: []}],
                params: taskIdParamsSchema,
                response: {
                    200: resultSchema(removeResultSchema),
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
        '/v1/downloads/clear-finished',
        {
            schema: {
                operationId: 'download.clearFinished',
                tags: ['download'],
                summary: '清空已完成任务',
                security: [{bearerAuth: []}],
                response: {
                    200: resultSchema(z.object({removed: z.number().int().nonnegative()})),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('download.clearFinished')],
        },
        notImplementedHandler,
    );
}
