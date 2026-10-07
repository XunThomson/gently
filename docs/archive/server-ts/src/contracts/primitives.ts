/**
 * 接口原语：统一信封、错误模型、游标分页、曲目引用。
 *
 * 这一层只依赖 zod，**不依赖 fastify**，因此可以被客户端 / 工具复用。
 * 与桌面端 `src/api/types.ts` 的语义保持一致；后端为权威实现方。
 */
import {z} from 'zod';

/* ============================== 错误码 ============================== */

/**
 * 机器可读错误码。新增需同步 `docs/contracts/backend-api.md`。
 * 约定：`域.原因`，前端按码做分支，不解析 message。
 */
export const ERROR_CODES = {
    unauthorized: 'auth.unauthorized',
    tokenExpired: 'auth.token_expired',
    forbidden: 'auth.forbidden',
    notFound: 'common.not_found',
    invalidArgument: 'common.invalid_argument',
    rateLimited: 'common.rate_limited',
    conflict: 'common.conflict',
    notImplemented: 'common.not_implemented',
    internal: 'common.internal',
    upgradeRequired: 'common.upgrade_required',
    upstreamFailed: 'source.upstream_failed',
    sourceUnavailable: 'source.unavailable',
    pluginNotFound: 'plugin.not_found',
    noSource: 'playback.no_source',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 每个错误码对应的 HTTP 状态码：错误映射集中在这里，路由不自行决定状态码 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
    [ERROR_CODES.unauthorized]: 401,
    [ERROR_CODES.tokenExpired]: 401,
    [ERROR_CODES.forbidden]: 403,
    [ERROR_CODES.notFound]: 404,
    [ERROR_CODES.invalidArgument]: 422,
    [ERROR_CODES.rateLimited]: 429,
    [ERROR_CODES.conflict]: 409,
    [ERROR_CODES.notImplemented]: 501,
    [ERROR_CODES.internal]: 500,
    [ERROR_CODES.upgradeRequired]: 426,
    [ERROR_CODES.upstreamFailed]: 502,
    [ERROR_CODES.sourceUnavailable]: 503,
    [ERROR_CODES.pluginNotFound]: 404,
    [ERROR_CODES.noSource]: 404,
};

/* ============================== 统一信封 ============================== */

export const apiErrorSchema = z.object({
    code: z.string().describe('机器可读错误码，见 ERROR_CODES'),
    message: z.string().describe('面向开发者的说明，不直接展示给用户'),
    details: z.record(z.unknown()).optional().describe('结构化细节，如字段校验结果'),
});

export type ApiErrorDto = z.infer<typeof apiErrorSchema>;

/** 失败信封：所有非 2xx 响应都用它，前端无需解析其它形状 */
export const errorResultSchema = z.object({
    ok: z.literal(false),
    error: apiErrorSchema,
    requestId: z.string(),
});

/** 成功信封工厂：`resultSchema(trackSchema)` */
export const resultSchema = <T extends z.ZodTypeAny>(data: T) =>
    z.union([
        z.object({ok: z.literal(true), data, requestId: z.string()}),
        errorResultSchema,
    ]);

/** 无返回体的成功响应 */
export const emptyResultSchema = resultSchema(z.null());

/* ============================== 分页 ============================== */

export const pageQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(30),
    cursor: z.string().optional().describe('上一页返回的 nextCursor'),
});

export type PageQueryDto = z.infer<typeof pageQuerySchema>;

/** 游标分页结果工厂（不用 offset，避免翻页时数据漂移） */
export const pageSchema = <T extends z.ZodTypeAny>(item: T) =>
    z.object({
        items: z.array(item),
        nextCursor: z.string().optional().describe('末页缺省'),
        hasMore: z.boolean(),
        total: z.number().int().optional().describe('仅在前端需要「共 N 条」时返回'),
    });

/* ============================== 通用引用 ============================== */

export const trackRefSchema = z.object({
    id: z.string().describe('统一曲目 id，形如 source:trackId'),
    source: z.string().describe('数据源（plugin）id'),
    sourceTrackId: z.string().describe('该源内的曲目 id'),
});

export const qualitySchema = z.enum(['standard', 'high', 'lossless', 'hires']);

export type QualityDto = z.infer<typeof qualitySchema>;

/** 幂等键请求头：写操作必须带，重放返回首次结果 */
export const idempotencyKeyHeaderSchema = z.object({
    'idempotency-key': z.string().min(8).max(128).optional(),
});

export const sortOrderSchema = z.enum(['asc', 'desc']);
