/**
 * 认证路由（auth）：登录 / 刷新 / 登出 / 当前用户资料。
 *
 * 为什么 `login` 与 `refresh` 不挂鉴权守卫：它们本身就是「用凭据换取令牌」的入口，
 * 若要求先持有令牌就形成死锁；因此这两个端点显式声明 `security: []`，
 * 但仍然声明 401 —— 口令错误、刷新令牌过期同样要走统一错误信封。
 *
 * 令牌的签发与校验全部由 `deps.tokens` 负责，路由层不接触密钥与散列算法。
 */
import {z} from 'zod';
import {userProfileSchema} from '../../contracts/models.js';
import {errorResultSchema, resultSchema} from '../../contracts/primitives.js';
import type {GentlyInstance} from '../instance.js';
import {notImplementedHandler} from '../result.js';

/**
 * 登录 / 刷新共用的令牌对。
 * 刷新**不重复下发 user**：客户端档案可能已被其它设备更新，用旧快照覆盖会回退数据。
 */
const tokenPairSchema = z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresInSec: z.number().int().positive(),
});

export async function registerAuthRoutes(app: GentlyInstance): Promise<void> {
    app.post(
        '/v1/auth/login',
        {
            schema: {
                operationId: 'auth.login',
                tags: ['auth'],
                summary: '登录，返回 access + refresh 令牌',
                // 换取令牌的入口，不能要求令牌
                security: [],
                body: z.object({
                    account: z.string().min(1).max(120),
                    password: z.string().min(1).max(128),
                }),
                response: {
                    200: resultSchema(tokenPairSchema.extend({user: userProfileSchema})),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
        },
        notImplementedHandler,
    );

    app.post(
        '/v1/auth/refresh',
        {
            schema: {
                operationId: 'auth.refresh',
                tags: ['auth'],
                summary: '轮换刷新令牌',
                // 刷新令牌本身就是凭据，不走 bearer 守卫
                security: [],
                body: z.object({refreshToken: z.string().min(1)}),
                response: {
                    200: resultSchema(tokenPairSchema),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
        },
        notImplementedHandler,
    );

    app.post(
        '/v1/auth/logout',
        {
            schema: {
                operationId: 'auth.logout',
                tags: ['auth'],
                summary: '登出并吊销当前会话',
                security: [{bearerAuth: []}],
                // `allDevices` 缺省只吊销当前会话；给默认值让客户端可以省略 body
                body: z.object({allDevices: z.boolean().default(false)}),
                response: {
                    200: resultSchema(z.object({revoked: z.literal(true)})),
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
        '/v1/auth/profile',
        {
            schema: {
                operationId: 'auth.profile',
                tags: ['auth'],
                summary: '当前用户资料',
                security: [{bearerAuth: []}],
                response: {
                    200: resultSchema(userProfileSchema),
                    401: errorResultSchema,
                    422: errorResultSchema,
                    501: errorResultSchema,
                },
            },
            preHandler: app.deps.requireAuth,
        },
        notImplementedHandler,
    );
}
