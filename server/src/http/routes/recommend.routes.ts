/**
 * 推荐路由（recommend）：首页聚合推荐、相似曲目、反馈回路。
 *
 * 与 `catalog.routes.ts` 保持同一结构，额外约定：
 *  1. `sourcesFilter` 就地声明（与曲库路由同义：逗号分隔字符串或重复参数 → string[]），
 *     推荐结果同样受音源过滤约束，避免客户端拿到不可播放的候选；
 *  2. `limit` 上限 50：推荐流是「首屏少量 + 滚动再取」，放大 limit 只会拖慢首屏；
 *  3. 反馈接口是画像更新的唯一入口，必须幂等——离线队列重放同一批
 *     播放 / 跳过事件时不能重复放大标签权重。
 */
import {z} from 'zod';
import {
    recommendFeedbackSchema,
    recommendationBundleSchema,
    recommendedTrackSchema,
    tasteProfileSchema,
} from '../../contracts/models.js';
import {errorResultSchema, resultSchema} from '../../contracts/primitives.js';
import type {GentlyInstance} from '../instance.js';
import {notImplementedHandler} from '../result.js';

/** 音源过滤参数：与 catalog 一致，多源接口通用 */
const sourcesFilter = z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('限定音源（多个用逗号分隔或重复参数）；缺省按用户偏好聚合')
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(',').filter(Boolean)));

/** 推荐条数：三个端点语义相同，抽出常量避免默认值漂移 */
const recommendLimit = z.coerce.number().int().min(1).max(50).default(12);

export async function registerRecommendRoutes(app: GentlyInstance): Promise<void> {
    app.get(
        '/v1/recommend/home',
        {
            schema: {
                operationId: 'recommend.home',
                tags: ['recommend'],
                summary: '首页推荐（单曲 + 专辑 + 歌单 + 画像）',
                security: [{bearerAuth: []}],
                querystring: z.object({
                    sources: sourcesFilter,
                    limit: recommendLimit,
                }),
                response: {
                    200: resultSchema(recommendationBundleSchema),
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
        '/v1/recommend/similar',
        {
            schema: {
                operationId: 'recommend.similar',
                tags: ['recommend'],
                summary: '相似曲目',
                security: [{bearerAuth: []}],
                querystring: z.object({
                    /** 统一曲目 id：`source:trackId`，与曲库 / 歌词接口同一引用体系 */
                    id: z.string().min(3),
                    limit: recommendLimit,
                    sources: sourcesFilter,
                }),
                response: {
                    200: resultSchema(z.object({items: z.array(recommendedTrackSchema)})),
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
        '/v1/recommend/feedback',
        {
            schema: {
                operationId: 'recommend.feedback',
                tags: ['recommend'],
                summary: '推荐反馈（播放 / 跳过 / 喜欢），驱动画像更新',
                security: [{bearerAuth: []}],
                body: recommendFeedbackSchema,
                response: {
                    200: resultSchema(
                        z.object({
                            accepted: z.literal(true),
                            /** 画像重算可能是异步任务：尚未算完时不下发，客户端沿用旧画像 */
                            profile: tasteProfileSchema.optional(),
                        }),
                    ),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            // 幂等 scope = 端点 id，与清单的 idempotent 标记一一对应
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('recommend.feedback')],
        },
        notImplementedHandler,
    );
}
