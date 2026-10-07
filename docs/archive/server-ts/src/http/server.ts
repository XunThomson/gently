/**
 * HTTP 服务器装配：只负责「全局中间件」，不含任何路由。
 *
 * 顺序很重要：
 *  1. 校验器 / 序列化器（Zod）→ 之后注册的路由才有 schema 能力；
 *  2. swagger（在路由之前注册才能收集到 schema）；
 *  3. 安全与横切（helmet / cors / rate-limit / websocket）；
 *  4. 路由由 `app.ts` 注册，错误处理在最后注册。
 */
import {randomUUID} from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import {serializerCompiler, validatorCompiler, type ZodTypeProvider} from 'fastify-type-provider-zod';
import type {AppEnv} from '../config/env.js';
import {ERROR_CODES} from '../contracts/primitives.js';
import {createLogger} from '../infra/logger.js';
import {ApiError, errorBody} from './errors.js';
import type {GentlyInstance} from './instance.js';
import {registerDocs} from './swagger.js';

/** 健康检查等探针接口不限流，否则会把运维监控挡在门外 */
const RATE_LIMIT_ALLOWLIST = ['/health', '/ready'];

export async function createServer(env: AppEnv): Promise<GentlyInstance> {
    const app = Fastify({
        loggerInstance: createLogger(env),
        // 用 UUID 作为 requestId：便于跨日志/客户端/工单检索
        genReqId: () => randomUUID(),
        trustProxy: true,
        bodyLimit: 8 * 1024 * 1024,
    }).withTypeProvider<ZodTypeProvider>();

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // 1 + 2. 文档与 schema 收集
    await registerDocs(app, env);

    // 3a. 安全响应头（API 服务不渲染 HTML，关掉 CSP 以免影响 /docs 自测页）
    await app.register(helmet, {contentSecurityPolicy: false, crossOriginResourcePolicy: {policy: 'cross-origin'}});

    // 3b. 跨域：桌面端（tauri://）与本地开发服务器
    await app.register(cors, {
        origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'if-none-match', 'x-client-version'],
        exposedHeaders: ['etag', 'retry-after', 'idempotency-replayed', 'x-request-id'],
        maxAge: 86_400,
    });

    // 3c. 限流：按 IP + 路由；响应体保持统一信封
    if (!env.isTest) {
        await app.register(rateLimit, {
            max: env.RATE_LIMIT_MAX,
            timeWindow: env.RATE_LIMIT_WINDOW_MS,
            allowList: (request) => RATE_LIMIT_ALLOWLIST.includes(request.url.split('?')[0] ?? ''),
            errorResponseBuilder: (request, context) => {
                const retryAfterSec = Math.ceil(context.ttl / 1000);
                return errorBody(
                    new ApiError(
                        ERROR_CODES.rateLimited,
                        `请求过于频繁，请 ${retryAfterSec} 秒后重试`,
                        undefined,
                        retryAfterSec,
                    ),
                    String(request.id),
                );
            },
        });
    }

    // 3d. 实时通道能力（具体路由在 routes/realtime 注册）
    await app.register(websocket, {
        options: {maxPayload: 1024 * 1024, clientTracking: true},
    });

    // 请求日志用 fastify 内建实现（含耗时与 requestId），不再额外挂 onResponse，
    // 否则同一次请求会出现两条「request completed」。测试环境由日志级别（silent）静音。
    return app;
}
