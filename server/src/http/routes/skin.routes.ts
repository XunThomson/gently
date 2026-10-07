/**
 * 皮肤路由（skin）：市场列表、详情、发布、我的皮肤、安装状态同步。
 *
 * 皮肤在服务端是**不透明文档**：后端只保证结构与版本（`overrides` 不解析），
 * 因此前端新增主题 token 不需要改后端，也不会因为 schema 严格而拒绝新皮肤。
 *
 * 同步语义：`skin.sync` 一次提交本机全部已安装皮肤 + 当前激活项，是**全量对账**，
 * 幂等键防重放；服务端返回递增的 `revision`，客户端携带旧 revision 时返回 409，
 * 避免多设备同时同步造成互相覆盖。
 */
import {z} from 'zod';
import {skinSchema, skinSyncPayloadSchema} from '../../contracts/models.js';
import {errorResultSchema, pageQuerySchema, pageSchema, resultSchema} from '../../contracts/primitives.js';
import type {GentlyInstance} from '../instance.js';
import {notImplementedHandler} from '../result.js';

/** 路径参数：皮肤 id */
const skinIdParamsSchema = z.object({id: z.string().min(1)});

/** 发布请求：id 由服务端生成、downloaded 是本机状态，都不接受客户端提交 */
const skinPublishBodySchema = skinSchema.omit({id: true, downloaded: true});

export async function registerSkinRoutes(app: GentlyInstance): Promise<void> {
    app.get(
        '/v1/skins',
        {
            schema: {
                operationId: 'skin.list',
                tags: ['skin'],
                summary: '皮肤市场分页',
                security: [{bearerAuth: []}],
                querystring: pageQuerySchema,
                response: {
                    200: resultSchema(pageSchema(skinSchema)),
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
        '/v1/skins/:id',
        {
            schema: {
                operationId: 'skin.detail',
                tags: ['skin'],
                summary: '皮肤详情',
                security: [{bearerAuth: []}],
                params: skinIdParamsSchema,
                response: {
                    200: resultSchema(skinSchema),
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
        '/v1/skins',
        {
            schema: {
                operationId: 'skin.publish',
                tags: ['skin'],
                summary: '发布皮肤（幂等）',
                security: [{bearerAuth: []}],
                body: skinPublishBodySchema,
                response: {
                    200: resultSchema(skinSchema),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('skin.publish')],
        },
        notImplementedHandler,
    );

    app.get(
        '/v1/me/skins',
        {
            schema: {
                operationId: 'skin.mine',
                tags: ['skin'],
                summary: '我的皮肤（离线副本对账用）',
                security: [{bearerAuth: []}],
                response: {
                    // 与下载/收藏的游标分页不同：本机皮肤数量有上限，一次全量下发更省往返
                    200: resultSchema(
                        z.object({
                            items: z.array(skinSchema),
                            activeSkinId: z.string().optional().describe('当前激活皮肤；未激活时缺省'),
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

    app.post(
        '/v1/me/skins/sync',
        {
            schema: {
                operationId: 'skin.sync',
                tags: ['skin'],
                summary: '皮肤安装状态同步（幂等）',
                security: [{bearerAuth: []}],
                body: skinSyncPayloadSchema,
                response: {
                    200: resultSchema(
                        z.object({
                            applied: z.number().int().describe('本次实际写入的皮肤条数'),
                            revision: z.number().int().describe('同步后的服务端版本号，下次提交需回传'),
                        }),
                    ),
                    401: errorResultSchema,
                    // revision 落后：另一台设备已改过，客户端需先拉取 /v1/me/skins 合并
                    409: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: [app.deps.requireAuth, app.deps.idempotencyGuard('skin.sync')],
        },
        notImplementedHandler,
    );
}
