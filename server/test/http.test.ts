/**
 * HTTP 层集成测试：走完整装配（中间件 → 路由 → 错误处理），用 `inject()` 断言。
 *
 * 覆盖三类「骨架必须成立」的行为：
 *  - 404 与 501 的语义分界（未知路径 vs 已登记未实现）；
 *  - 探针端点在**未配置外部依赖**时的降级表现（degraded / unconfigured / memory）；
 *  - Zod 校验失败被统一映射为 422 `common.invalid_argument`，且 details.issues 可用。
 */
import {describe, expect, test} from 'vitest';
import {ERROR_CODES} from '../src/contracts/primitives.js';
import {authHeaders, makeApp, testEnv} from './helpers.js';

/** 响应体里我们关心的字段（测试内用宽松类型，避免和契约 schema 耦合） */
interface Body {
    ok?: unknown;
    data?: {
        version?: unknown;
        uptimeSec?: unknown;
        status?: unknown;
        checks?: {
            db?: {status?: unknown; kind?: unknown};
            cache?: {status?: unknown; kind?: unknown};
        };
    };
    error?: {code?: unknown; details?: {issues?: unknown}};
    requestId?: unknown;
}

const codeOf = (body: Body): unknown => body.error?.code;

describe('HTTP 层行为', () => {
    test('环境构造：未配置 Postgres / Redis（测试不依赖外部服务）', () => {
        const env = testEnv();
        expect(env.isTest).toBe(true);
        expect(env.hasDatabase).toBe(false);
        expect(env.hasRedis).toBe(false);
    });

    test('未知路径 → 404 common.not_found（与「已登记未实现」的 501 区分）', async () => {
        const app = await makeApp();
        try {
            const response = await app.inject({method: 'GET', url: '/v1/definitely-not-a-route'});
            const body = response.json() as Body;
            expect(response.statusCode).toBe(404);
            expect(codeOf(body)).toBe(ERROR_CODES.notFound);
            expect(typeof body.requestId).toBe('string');
        } finally {
            await app.close();
        }
    });

    test('/health → 200，包含版本与 uptimeSec', async () => {
        const app = await makeApp();
        try {
            const response = await app.inject({method: 'GET', url: '/health'});
            const body = response.json() as Body;
            expect(response.statusCode).toBe(200);
            expect(body.ok).toBe(true);
            expect(typeof body.data?.version).toBe('string');
            expect(typeof body.data?.uptimeSec).toBe('number');
        } finally {
            await app.close();
        }
    });

    test('/ready → 200 degraded，未配置的依赖标记 unconfigured', async () => {
        const app = await makeApp();
        try {
            const response = await app.inject({method: 'GET', url: '/ready'});
            const body = response.json() as Body;
            // 未配置 ≠ 不健康：骨架阶段允许无外部依赖运行，因此是 200 + degraded
            expect(response.statusCode).toBe(200);
            expect(body.data?.status).toBe('degraded');
            expect(body.data?.checks?.db?.status).toBe('unconfigured');
            expect(body.data?.checks?.db?.kind).toBe('none');
            expect(body.data?.checks?.cache?.status).toBe('unconfigured');
        } finally {
            await app.close();
        }
    });

    test('非法查询参数（/v1/search 缺 keyword）→ 422 common.invalid_argument + details.issues', async () => {
        const app = await makeApp();
        try {
            const headers = await authHeaders(app);
            const response = await app.inject({method: 'GET', url: '/v1/search', headers});
            const body = response.json() as Body;
            expect(response.statusCode).toBe(422);
            expect(codeOf(body)).toBe(ERROR_CODES.invalidArgument);
            expect(Array.isArray(body.error?.details?.issues)).toBe(true);
            expect((body.error?.details?.issues as unknown[]).length).toBeGreaterThan(0);
        } finally {
            await app.close();
        }
    });

    test('无效令牌 → 401 auth.unauthorized', async () => {
        const app = await makeApp();
        try {
            const response = await app.inject({
                method: 'GET',
                url: '/v1/search?keyword=x',
                headers: {authorization: 'Bearer not-a-real-token'},
            });
            expect(response.statusCode).toBe(401);
            expect(codeOf(response.json() as Body)).toBe(ERROR_CODES.unauthorized);
        } finally {
            await app.close();
        }
    });

    test('未配置 Redis 时幂等存储降级为内存实现', async () => {
        const app = await makeApp();
        try {
            expect(app.deps.env.hasRedis).toBe(false);
            expect(app.deps.idempotency.kind).toBe('memory');
        } finally {
            await app.close();
        }
    });
});
