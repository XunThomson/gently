/**
 * 播放路由（playback）：播放地址解析与播放完成度上报。
 *
 * 关键语义：`playback.resolve` 在**全部音源都失败**时返回 `data: null`，而不是抛错。
 * 播放失败是列表里的常态（某首歌所有源都下架），客户端据此提示并回退到本地文件；
 * 若返回 5xx，会被客户端统一错误处理误判为服务故障，进而触发全量重试。
 *
 * `playback.report` 是幂等的：桌面端离线队列会重放上报，重复计入会污染推荐画像。
 */
import {z} from 'zod';
import {
    playbackReportSchema,
    playbackResolveRequestSchema,
    playbackResolveResponseSchema,
} from '../../contracts/models.js';
import {errorResultSchema, resultSchema} from '../../contracts/primitives.js';
import type {GentlyInstance} from '../instance.js';
import {notImplementedHandler} from '../result.js';

export async function registerPlaybackRoutes(app: GentlyInstance): Promise<void> {
    app.post(
        '/v1/playback/resolve',
        {
            schema: {
                operationId: 'playback.resolve',
                tags: ['playback'],
                summary: '解析播放地址；全部音源失败时返回 data: null（不是错误）',
                security: [{bearerAuth: []}],
                body: playbackResolveRequestSchema,
                response: {
                    200: resultSchema(
                        playbackResolveResponseSchema
                            .nullable()
                            .describe('全部音源均不可用时为 null，客户端应回退本地文件'),
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

    app.post(
        '/v1/playback/report',
        {
            schema: {
                operationId: 'playback.report',
                tags: ['playback'],
                summary: '播放完成度上报',
                security: [{bearerAuth: []}],
                body: playbackReportSchema,
                response: {
                    200: resultSchema(z.object({accepted: z.literal(true)})),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            // 先鉴权（确定上报归属），再做幂等去重（重放不重复计数）
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('playback.report')],
        },
        notImplementedHandler,
    );
}
