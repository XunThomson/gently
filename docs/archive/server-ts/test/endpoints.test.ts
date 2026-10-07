/**
 * 端点清单守卫测试（核心）。
 *
 * 为什么值得单独写一整组：
 *  - 契约骨架最容易出现的退化是「清单里登记了端点，但路由文件忘了实现」——
 *    此时客户端会拿到 404，与「后端没这个接口」无法区分。断言 1 就是钉死这一点：
 *    **清单里的路径必须已注册**，实现与否只体现为 501；
 *  - 鉴权与幂等由路由自己挂 `preHandler`，漏挂不会报错但会造成越权/重复写，
 *    因此逐端点断言 401 与 422；
 *  - 断言按「清单」而不是「路由文件」驱动，路由补齐后无需改测试。
 *
 * 关键前提：fastify 的请求校验（body / query / params）发生在**处理器之前**，
 * 而幂等守卫也在处理器之前。因此要观察「处理器语义」（501），
 * 必须先提供合法请求——否则只会看到 422，那是校验层的正确行为，与占位语义无关。
 * 每个端点的合法请求样例集中在 `BODIES` / `QUERY_OVERRIDES`。
 *
 * 未注册的端点会在断言 1 中失败并列出具体端点（这是期望行为：提醒补齐路由），
 * 而不是让后续断言静默跳过。
 */
import type {InjectOptions} from 'fastify';
import {describe, expect, test} from 'vitest';
import {ENDPOINTS, type EndpointSpec} from '../src/contracts/endpoints.js';
import {ERROR_CODES} from '../src/contracts/primitives.js';
import {authHeaders, devApp, makeApp} from './helpers.js';

/** 失败响应里的错误信息：仅用于生成可读的失败原因 */
interface ErrorDto {
    code?: unknown;
    message?: unknown;
}

interface Envelope {
    ok?: unknown;
    data?: unknown;
    error?: ErrorDto;
    requestId?: unknown;
}

/** 路径参数 → 合法样例值；`ref` / 插件 `id` 用真实形态，能顺带验证编码与最小长度约束 */
const PARAM_SAMPLES: Record<string, string> = {
    ref: 'mock:1',
    id: 'sample-id',
};

/** 端点查询参数覆盖：只补「必填且无默认值」的参数，其余走 schema 默认值 */
const QUERY_OVERRIDES: Record<string, Record<string, string>> = {
    'catalog.search': {keyword: 'x'},
    'catalog.charts': {chart: 'hot', period: 'day'},
    'catalog.lyrics': {id: 'mock:1'},
    'recommend.similar': {id: 'mock:1'},
};

/**
 * POST / PUT / PATCH 请求体样例（按端点 id）。
 * 只补 schema 必填字段：目的是穿过校验层、到达处理器，从而断言 501。
 * 内容语义无意义（业务未接入），但**结构必须合法**，否则断言会变成在校验层失败。
 */
const trackRef = {id: 'mock:1', source: 'mock', sourceTrackId: '1'};

const BODIES: Record<string, unknown> = {
    'auth.login': {account: 'test@example.com', password: 'test-password'},
    'auth.refresh': {refreshToken: 'test-refresh-token'},
    'auth.logout': {allDevices: false},
    'library.favorites.sync': {
        idempotencyKey: 'test-favorites-key',
        added: [],
        removed: [],
        clientTime: '2025-01-01T00:00:00.000Z',
    },
    'library.playlists.create': {name: '测试歌单', trackRefs: []},
    'library.history.push': {trackRef, playedAt: 1_700_000_000_000, playCount: 1},
    'recommend.feedback': {trackRef, kind: 'play', clientTime: '2025-01-01T00:00:00.000Z'},
    'playback.resolve': {track: trackRef, quality: 'high'},
    'playback.report': {
        trackRef,
        source: 'mock',
        playedSec: 30,
        completed: false,
        clientTime: '2025-01-01T00:00:00.000Z',
    },
    'plugin.install': {id: 'mock', confirmed: true},
    'plugin.uninstall': {id: 'mock'},
    'plugin.config.put': {values: {}, revision: 0},
    'download.create': {trackRef, quality: 'high'},
    'skin.publish': {name: '测试皮肤', author: 'tester', version: '1.0.0', overrides: {}},
    'skin.sync': {idempotencyKey: 'test-skin-key', installed: [], clientTime: '2025-01-01T00:00:00.000Z'},
};

/**
 * 显式声明「无请求体」的 POST 端点。
 *
 * 这些端点的语义决定了不需要 body（按路径参数或服务端清单推导），
 * 列在这里是为了让下面的守卫测试能够区分「确实不需要 body」与「忘记写样例」。
 */
const NO_BODY_REQUIRED: ReadonlySet<string> = new Set([
    'plugin.checkUpdates',
    'download.pause',
    'download.resume',
    'download.clearFinished',
]);

/** 插件配置端点：`:id` 用插件 id 形态（`mock`），而非通用 `sample-id` */
const PLUGIN_CONFIG_PATH = '/v1/plugins/:id/config';

/** 幂等端点在断言 3 中使用的请求头：≥8 字符，满足幂等守卫的最小长度 */
const IDEMPOTENCY_KEY = 'test-idempotency-key';

const pathFor = (spec: EndpointSpec): string => {
    const withParams = spec.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
        // 兜底用参数名本身，保证新参数不会踩到 min(1) 校验；
        // 若将来某端点要求更严格的格式（如 uuid），需在上面显式补样例值
        const sample = spec.path === PLUGIN_CONFIG_PATH && name === 'id' ? 'mock' : (PARAM_SAMPLES[name] ?? name);
        // 路径段必须编码：`mock:1` 里的冒号未编码时容易被中间层误解析
        return encodeURIComponent(sample);
    });
    const query = QUERY_OVERRIDES[spec.id] ?? {};
    const search = new URLSearchParams(query).toString();
    return search.length > 0 ? `${withParams}?${search}` : withParams;
};

/**
 * 构造一条「能穿过校验层」的合法请求。
 * `idempotent` 端点默认带上幂等键：断言 5 专门验证缺键的 422，其余断言需要键才能到达处理器。
 * 显式标注 `InjectOptions`：否则条件展开会把 payload 推断成不可赋值的联合类型。
 */
const requestFor = (spec: EndpointSpec, headers: Record<string, string> = {}): InjectOptions => {
    const body: unknown = BODIES[spec.id];
    return {
        method: spec.method,
        url: pathFor(spec),
        headers: spec.idempotent === true ? {...headers, 'idempotency-key': IDEMPOTENCY_KEY} : headers,
        ...(body === undefined || body === null ? {} : {payload: body}),
    };
};

const reasonOf = (body: unknown): string => {
    const {error} = (body ?? {}) as Envelope;
    return typeof error?.code === 'string' ? error.code : '（无 error.code）';
};

const hasRequestId = (body: unknown): boolean => {
    const {requestId} = (body ?? {}) as Envelope;
    return typeof requestId === 'string' && requestId.length > 0;
};

const describeSpec = (spec: EndpointSpec): string => `${spec.method} ${spec.path} (${spec.id})`;

describe('端点清单守卫', () => {
    test('每个含请求体的端点都有测试样例（防止新增 POST 端点后断言静默退化）', () => {
        const missing = ENDPOINTS.filter(
            (spec) =>
                (spec.method === 'POST' || spec.method === 'PUT' || spec.method === 'PATCH') &&
                !NO_BODY_REQUIRED.has(spec.id) &&
                BODIES[spec.id] === undefined,
        ).map((spec) => spec.id);
        expect(missing, `以下端点缺少合法请求体样例：${missing.join(', ')}`).toEqual([]);
    });

    test('断言 1：清单中每个端点都已注册（任何端点都不能返回 404）', async () => {
        const app = await makeApp();
        try {
            const headers = await authHeaders(app);
            const missing: string[] = [];

            for (const spec of ENDPOINTS) {
                const request = requestFor(spec, headers);
                // 带合法令牌与合法请求体：把「未鉴权 / 参数非法」这两个变量排除，只看路由是否存在
                const response = await app.inject(request);
                const body = response.json() as Envelope;
                // 唯一允许的 404 是「资源不存在」，由处理器返回，message 不会以「接口不存在」开头
                const notRegistered =
                    response.statusCode === 404 &&
                    reasonOf(body) === ERROR_CODES.notFound &&
                    String(body.error?.message ?? '').startsWith('接口不存在');
                if (notRegistered) missing.push(`${describeSpec(spec)} → ${request.url}`);
            }

            expect(
                missing,
                `以下端点已在 ENDPOINTS 登记但路由未注册（应返回 501 而非 404）：\n${missing.join('\n')}`,
            ).toEqual([]);

            // 额外守住总覆盖面：清单被清空或大面积丢失时上面的循环会「空跑通过」
            expect(ENDPOINTS.length).toBeGreaterThan(0);
        } finally {
            await app.close();
        }
    });

    test.each(ENDPOINTS)('断言 2：鉴权边界 $id', async (spec) => {
        const app = await makeApp();
        try {
            // 不带任何令牌（但请求体合法，否则只会看到校验层的 422）
            const response = await app.inject(requestFor(spec));
            if (spec.auth) {
                expect(response.statusCode, `${describeSpec(spec)} 应要求鉴权`).toBe(401);
                expect(reasonOf(response.json())).toBe(ERROR_CODES.unauthorized);
            } else {
                expect(response.statusCode, `${describeSpec(spec)} 是公开端点，不应返回 401`).not.toBe(401);
            }
        } finally {
            await app.close();
        }
    });

    test.each(ENDPOINTS.filter((spec) => !spec.implemented))('断言 3：未实现端点占位语义 $id', async (spec) => {
        const app = await makeApp();
        try {
            const headers = await authHeaders(app);
            const response = await app.inject(requestFor(spec, headers));
            const body = response.json() as Envelope;
            expect(response.statusCode, `${describeSpec(spec)} 未接入业务时应返回 501（${reasonOf(body)}）`).toBe(501);
            expect(reasonOf(body)).toBe(ERROR_CODES.notImplemented);
            // 501 也必须带 envelope 的 requestId，便于与日志对齐
            expect(hasRequestId(body)).toBe(true);
        } finally {
            await app.close();
        }
    });

    test.each(ENDPOINTS.filter((spec) => spec.implemented))('断言 4：已实现端点返回成功信封 $id', async (spec) => {
        const app = await makeApp();
        try {
            const response = await app.inject(requestFor(spec));
            expect(response.statusCode, `${describeSpec(spec)} 属于基础设施端点，应已实现`).toBe(200);
            expect((response.json() as Envelope).ok).toBe(true);
        } finally {
            await app.close();
        }
    });

    test.each(ENDPOINTS.filter((spec) => spec.idempotent === true))('断言 5：幂等端点缺少幂等键 → 422 $id', async (spec) => {
        const app = await makeApp();
        try {
            const headers = await authHeaders(app);
            // 只带令牌、不带 Idempotency-Key：应被幂等守卫拒绝，而不是落到 501
            const request = {...requestFor(spec, headers), headers};
            const response = await app.inject(request);
            const body = response.json() as Envelope;
            expect(response.statusCode, `${describeSpec(spec)} 缺少 Idempotency-Key 时应返回 422（${reasonOf(body)}）`).toBe(422);
            expect(reasonOf(body)).toBe(ERROR_CODES.invalidArgument);
        } finally {
            await app.close();
        }
    });

    test('开发模式（AUTH_REQUIRED=false）无令牌也能落到未实现处理器 → 501', async () => {
        const app = await devApp();
        try {
            // 无令牌 → 守卫注入开发主体 → 未实现处理器返回 501（而不是 401）
            const response = await app.inject({method: 'GET', url: '/v1/search?keyword=x'});
            const body = response.json() as Envelope;
            expect(response.statusCode, `开发模式应放行到处理器（${reasonOf(body)}）`).toBe(501);
            expect(reasonOf(body)).toBe(ERROR_CODES.notImplemented);
        } finally {
            await app.close();
        }
    });
});
