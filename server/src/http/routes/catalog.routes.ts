/**
 * 曲库路由（catalog）：检索、榜单、曲目、专辑、精选歌单、歌词。
 *
 * 本文件是**路由写法的范例**（其它域照此结构）：
 *  1. `operationId` 必须与 `contracts/endpoints.ts` 中的 `id` 一致；
 *  2. 请求 schema 就地声明（查询参数属于 HTTP 层），响应 schema 复用 `contracts/models.ts`；
 *  3. 鉴权 / 幂等守卫从 `app.deps` 取，不在路由里判断令牌；
 *  4. 未实现业务统一挂 `notImplementedHandler`（返回 501，语义为「契约已定，实现待接」）。
 *
 * 多音源约定：列表类接口返回 `GroupedTrack`（同一首歌合并、`candidates` 按优先级排序），
 * 前端按候选顺序做播放回退，因此**后端排序即优先级**。
 */
import {z} from 'zod';
import {
    albumSchema,
    chartEntrySchema,
    chartTypeSchema,
    groupedTrackSchema,
    lyricsSchema,
    periodSchema,
    curatedPlaylistSchema,
} from '../../contracts/models.js';
import {errorResultSchema, pageQuerySchema, pageSchema, qualitySchema, resultSchema} from '../../contracts/primitives.js';
import type {GentlyInstance} from '../instance.js';
import {notImplementedHandler} from '../result.js';

/** 音源过滤参数：多源接口通用 */
const sourcesFilter = z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('限定音源（多个用逗号分隔或重复参数）；缺省按用户偏好聚合')
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(',').filter(Boolean)));

const dateText = z.string().regex(/^\d{4}(-\d{2}){0,2}$/, '日期格式：YYYY / YYYY-MM / YYYY-MM-DD');

export async function registerCatalogRoutes(app: GentlyInstance): Promise<void> {
    app.get(
        '/v1/search',
        {
            schema: {
                operationId: 'catalog.search',
                tags: ['catalog'],
                summary: '跨源检索；后端负责去重与候选音源排序',
                security: [{bearerAuth: []}],
                querystring: z
                    .object({
                        keyword: z.string().min(1).max(120),
                        sources: sourcesFilter,
                        minQuality: qualitySchema.optional(),
                    })
                    .merge(pageQuerySchema),
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

    app.get(
        '/v1/charts',
        {
            schema: {
                operationId: 'catalog.charts',
                tags: ['catalog'],
                summary: '榜单（类型 + 周期 + 日期）',
                security: [{bearerAuth: []}],
                querystring: z.object({
                    chart: chartTypeSchema,
                    period: periodSchema,
                    /** 周期对应的起始日期；缺省为当前周期 */
                    date: dateText.optional(),
                    sources: sourcesFilter,
                    limit: z.coerce.number().int().min(1).max(200).default(100),
                }),
                response: {
                    200: resultSchema(
                        z.object({
                            chart: chartTypeSchema,
                            period: periodSchema,
                            date: dateText,
                            entries: z.array(chartEntrySchema),
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
        '/v1/tracks/:ref',
        {
            schema: {
                operationId: 'catalog.track',
                tags: ['catalog'],
                summary: '曲目详情（含全部候选音源）',
                security: [{bearerAuth: []}],
                params: z.object({
                    /** 统一曲目 id：`source:trackId`（含冒号，需 URL 编码） */
                    ref: z.string().min(3),
                }),
                response: {
                    200: resultSchema(groupedTrackSchema),
                    401: errorResultSchema,
                    404: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: app.deps.requireAuth,
        },
        notImplementedHandler,
    );

    app.get(
        '/v1/albums/:id',
        {
            schema: {
                operationId: 'catalog.album',
                tags: ['catalog'],
                summary: '专辑详情',
                security: [{bearerAuth: []}],
                params: z.object({id: z.string().min(1)}),
                response: {
                    200: resultSchema(albumSchema),
                    401: errorResultSchema,
                    404: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: app.deps.requireAuth,
        },
        notImplementedHandler,
    );

    app.get(
        '/v1/curated/:id',
        {
            schema: {
                operationId: 'catalog.curated',
                tags: ['catalog'],
                summary: '编辑精选歌单详情',
                security: [{bearerAuth: []}],
                params: z.object({id: z.string().min(1)}),
                response: {
                    200: resultSchema(curatedPlaylistSchema),
                    401: errorResultSchema,
                    404: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: app.deps.requireAuth,
        },
        notImplementedHandler,
    );

    app.get(
        '/v1/lyrics',
        {
            schema: {
                operationId: 'catalog.lyrics',
                tags: ['catalog'],
                summary: '歌词（按曲目引用查询）',
                security: [{bearerAuth: []}],
                querystring: z.object({
                    id: z.string().min(3).describe('统一曲目 id：source:trackId'),
                    source: z.string().optional().describe('优先取词音源；缺省按候选顺序'),
                }),
                response: {
                    200: resultSchema(lyricsSchema.nullable().describe('无歌词时返回 null，而不是错误')),
                    401: errorResultSchema,
                    404: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: app.deps.requireAuth,
        },
        notImplementedHandler,
    );
}
