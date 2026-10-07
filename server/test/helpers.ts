/**
 * 测试辅助：环境构造、应用装配与令牌签发。
 *
 * 之所以在这里用 `buildApp({env})` 而不是起真实进程：
 *  - fastify 的 `inject()` 是进程内请求，不需要端口，也不受并发端口占用影响；
 *  - 每个用例拿到独立实例，互不污染（`loadEnv` 返回的是新对象，不是单例）。
 *
 * 另外显式清掉 `DATABASE_URL` / `REDIS_URL`：`config/env.ts` 会加载 `.env`，
 * 本地若配置了外部依赖，测试就会从「未配置 → degraded」变成「尝试连库」，
 * 断言随之不确定。测试必须自给自足。
 */
import {buildApp} from '../src/app.js';
import {loadEnv, type AppEnv} from '../src/config/env.js';

/** 满足 `JWT_SECRET` 最小长度（32）的固定测试密钥；仅用于测试 */
const TEST_JWT_SECRET = 'gently-test-secret-0123456789-abcdefghijklmnop';

/**
 * 构造测试环境。
 *
 * `loadEnv(source)` 直接吃传入对象，因此这里传的是一份**独立**的配置，
 * 不依赖也不修改 `process.env`。
 */
export const testEnv = (overrides: Record<string, string> = {}): AppEnv => {
    // 外部依赖默认不存在：探针用例据此断言 unconfigured / memory 降级
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;

    return loadEnv({
        NODE_ENV: 'test',
        AUTH_REQUIRED: 'true',
        JWT_SECRET: TEST_JWT_SECRET,
        ...overrides,
    });
};

/** 启用鉴权（默认）的实例：用于验证 401 / 501 / 422 等契约行为 */
export async function makeApp(overrides: Record<string, string> = {}) {
    return buildApp({env: testEnv(overrides)});
}

/**
 * 关闭鉴权的实例：无令牌时守卫会注入开发主体。
 *
 * 开发模式下没有登录实现，`AUTH_REQUIRED: 'false'` 是唯一能走通
 * 「已通过鉴权 → 落到未实现处理器」的路径，用来验证 501 分支。
 */
export async function devApp() {
    return buildApp({env: testEnv({AUTH_REQUIRED: 'false'})});
}

/** 用 `app.deps.tokens` 签发访问令牌，返回可直接透传给 `inject()` 的请求头 */
export async function authHeaders(app: Awaited<ReturnType<typeof buildApp>>): Promise<Record<string, string>> {
    const {accessToken} = await app.deps.tokens.issue({userId: 'test-user', nickname: '测试'});
    return {authorization: `Bearer ${accessToken}`};
}
