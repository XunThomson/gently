/**
 * 用户数据路由（library）：收藏、歌单、最近播放。
 *
 * 结构与 `catalog.routes.ts` 一致：
 *  1. `operationId` 与 `contracts/endpoints.ts` 的 `id` 完全一致（OpenAPI 与前端代码生成都依赖它）；
 *  2. 查询参数等 HTTP 层 schema 就地声明，响应模型复用 `contracts/models.ts`；
 *  3. 鉴权与幂等一律从 `app.deps` 取：路由不解析令牌、不判断重放，
 *     这样测试可以整体替换 `requireAuth` / `idempotencyGuard` 而无需改路由；
 *  4. 写接口（sync / create / push）在清单里标记 `idempotent: true`，
 *     因此 `preHandler` 必须同时挂鉴权与幂等守卫，且在鉴权之后执行
 *     （幂等键的作用域按用户隔离，先确认身份再落库）。
 *
 * 收藏与历史都是「客户端可离线产生、联网后补传」的数据，所以同步类接口
 * 走增量 delta + 幂等键，而不是让客户端直接 PUT 全量。
 */
import {z} from 'zod';
import {
    favoriteDeltaSchema,
    groupedTrackSchema,
    playlistPayloadSchema,
    playlistSchema,
    recentTrackSchema,
} from '../../contracts/models.js';
import {errorResultSchema, pageQuerySchema, pageSchema, resultSchema} from '../../contracts/primitives.js';
import type {GentlyInstance} from '../instance.js';
import {notImplementedHandler} from '../result.js';

export async function registerLibraryRoutes(app: GentlyInstance): Promise<void> {
    app.get(
        '/v1/me/favorites',
        {
            schema: {
                operationId: 'library.favorites.list',
                tags: ['library'],
                summary: '收藏分页',
                security: [{bearerAuth: []}],
                querystring: pageQuerySchema,
                response: {
                    200: resultSchema(pageSchema(groupedTrackSchema)),
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
        '/v1/me/favorites/sync',
        {
            schema: {
                operationId: 'library.favorites.sync',
                tags: ['library'],
                summary: '收藏增量同步（幂等）',
                security: [{bearerAuth: []}],
                body: favoriteDeltaSchema,
                response: {
                    200: resultSchema(
                        z.object({
                            applied: z.number().int().describe('本次实际写入的收藏变更条数'),
                            revision: z.number().int().describe('服务端收藏版本号，客户端据此对齐本地副本'),
                        }),
                    ),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            // 幂等 scope 用端点 id：与清单一一对应，便于按接口维度排查重放
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('library.favorites.sync')],
        },
        notImplementedHandler,
    );

    app.get(
        '/v1/me/playlists',
        {
            schema: {
                operationId: 'library.playlists.list',
                tags: ['library'],
                summary: '歌单列表',
                security: [{bearerAuth: []}],
                response: {
                    200: resultSchema(z.object({items: z.array(playlistSchema)})),
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
        '/v1/me/playlists',
        {
            schema: {
                operationId: 'library.playlists.create',
                tags: ['library'],
                summary: '创建 / 覆盖歌单（幂等）',
                security: [{bearerAuth: []}],
                body: playlistPayloadSchema,
                response: {
                    200: resultSchema(playlistSchema),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('library.playlists.create')],
        },
        notImplementedHandler,
    );

    app.delete(
        '/v1/me/playlists/:id',
        {
            schema: {
                operationId: 'library.playlists.delete',
                tags: ['library'],
                summary: '删除歌单',
                security: [{bearerAuth: []}],
                params: z.object({id: z.string().min(1)}),
                response: {
                    200: resultSchema(z.object({id: z.string(), deleted: z.literal(true)})),
                    401: errorResultSchema,
                    // 有 :id 参数：歌单不存在（或不属于当前用户）时返回 404 而非静默成功
                    404: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: app.deps.requireAuth,
        },
        notImplementedHandler,
    );

    app.get(
        '/v1/me/history',
        {
            schema: {
                operationId: 'library.history.list',
                tags: ['library'],
                summary: '最近播放分页',
                security: [{bearerAuth: []}],
                querystring: pageQuerySchema,
                response: {
                    200: resultSchema(pageSchema(recentTrackSchema)),
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
        '/v1/me/history',
        {
            schema: {
                operationId: 'library.history.push',
                tags: ['library'],
                summary: '上报播放记录（幂等）',
                security: [{bearerAuth: []}],
                body: recentTrackSchema,
                response: {
                    200: resultSchema(z.object({accepted: z.literal(true)})),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('library.history.push')],
        },
        notImplementedHandler,
    );
}
