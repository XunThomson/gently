/**
 * 错误模型与全局错误映射。
 *
 * 约定：业务代码只抛 `ApiError`（或让 Zod 校验失败），
 * **HTTP 状态码由 `ERROR_STATUS` 决定**，任何地方都不手写状态码。
 */
import type {FastifyError, FastifyReply, FastifyRequest} from 'fastify';
import {ZodError} from 'zod';
import {ERROR_CODES, ERROR_STATUS, type ErrorCode} from '../contracts/primitives.js';
import type {GentlyInstance} from './instance.js';

export class ApiError extends Error {
    readonly code: ErrorCode;
    readonly details?: Record<string, unknown>;
    /** 限流等场景透传到 Retry-After 响应头 */
    readonly retryAfterSec?: number;

    constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>, retryAfterSec?: number) {
        super(message ?? code);
        this.name = 'ApiError';
        this.code = code;
        this.details = details;
        this.retryAfterSec = retryAfterSec;
    }

    get status(): number {
        return ERROR_STATUS[this.code];
    }

    static unauthorized(message = '未登录或令牌无效'): ApiError {
        return new ApiError(ERROR_CODES.unauthorized, message);
    }

    static tokenExpired(message = '访问令牌已过期'): ApiError {
        return new ApiError(ERROR_CODES.tokenExpired, message);
    }

    static forbidden(message = '无权限访问该资源'): ApiError {
        return new ApiError(ERROR_CODES.forbidden, message);
    }

    static notFound(message = '资源不存在'): ApiError {
        return new ApiError(ERROR_CODES.notFound, message);
    }

    static invalidArgument(message = '参数校验失败', details?: Record<string, unknown>): ApiError {
        return new ApiError(ERROR_CODES.invalidArgument, message, details);
    }

    static notImplemented(message?: string): ApiError {
        return new ApiError(ERROR_CODES.notImplemented, message);
    }

    static conflict(message = '资源已被修改，请刷新后重试'): ApiError {
        return new ApiError(ERROR_CODES.conflict, message);
    }

    static internal(message = '服务内部错误'): ApiError {
        return new ApiError(ERROR_CODES.internal, message);
    }

    static upstreamFailed(message = '上游音源请求失败'): ApiError {
        return new ApiError(ERROR_CODES.upstreamFailed, message);
    }

    static sourceUnavailable(message = '音源当前不可用'): ApiError {
        return new ApiError(ERROR_CODES.sourceUnavailable, message);
    }

    static noSource(message = '没有可用音源'): ApiError {
        return new ApiError(ERROR_CODES.noSource, message);
    }
}

interface ErrorBody {
    ok: false;
    error: {code: string; message: string; details?: Record<string, unknown>};
    requestId: string;
}

export function errorBody(error: ApiError, requestId: string): ErrorBody {
    return {
        ok: false,
        error: {
            code: error.code,
            message: error.message,
            ...(error.details ? {details: error.details} : {}),
        },
        requestId,
    };
}

/** Zod 校验失败 → `common.invalid_argument`，并把 issues 放进 details 供前端定位字段 */
function fromZod(error: ZodError): ApiError {
    return ApiError.invalidArgument('参数校验失败', {
        issues: error.issues.map((i) => ({path: i.path.join('.'), message: i.message, code: i.code})),
    });
}

/** fastify 内置校验（schema 之外的场景）→ 同样映射到 invalid_argument */
function fromFastifyValidation(error: FastifyError): ApiError | null {
    if (!error.validation || error.validation.length === 0) return null;
    return ApiError.invalidArgument('参数校验失败', {
        issues: error.validation.map((v) => ({
            path: v.instancePath || String(v.params?.['missingProperty'] ?? ''),
            message: v.message ?? 'invalid',
            code: v.keyword ?? 'invalid',
        })),
    });
}

/** 把任意异常归一化为 ApiError；未知异常一律 internal 且不泄漏堆栈 */
export function toApiError(error: unknown): {apiError: ApiError; unexpected: boolean} {
    if (error instanceof ApiError) return {apiError: error, unexpected: false};
    if (error instanceof ZodError) return {apiError: fromZod(error), unexpected: false};

    const fastifyError = error as FastifyError;
    const validation = fromFastifyValidation(fastifyError);
    if (validation) return {apiError: validation, unexpected: false};

    if (fastifyError.statusCode === 429) {
        return {apiError: new ApiError(ERROR_CODES.rateLimited, '请求过于频繁，请稍后重试'), unexpected: false};
    }
    if (fastifyError.statusCode === 401) return {apiError: ApiError.unauthorized(), unexpected: false};
    if (fastifyError.statusCode === 403) return {apiError: ApiError.forbidden(), unexpected: false};
    if (fastifyError.statusCode === 404) return {apiError: ApiError.notFound(), unexpected: false};

    return {apiError: ApiError.internal(), unexpected: true};
}

/**
 * 注册全局错误处理与 404 处理（在插件注册完毕后调用）。
 * `isProduction` 为真时不把未知异常的原始信息返回给客户端。
 */
export function registerErrorHandling(app: GentlyInstance, isProduction: boolean): void {
    app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
        // 未登记的路径：明确告诉调用方「没有这个接口」，与「未实现(501)」区分开
        return reply
            .status(404)
            .send(errorBody(ApiError.notFound(`接口不存在：${request.method} ${request.url}`), String(request.id)));
    });

    app.setErrorHandler((error, request, reply) => {
        const {apiError, unexpected} = toApiError(error);
        if (unexpected) {
            request.log.error({err: error}, 'unhandled error');
            const safe = isProduction
                ? ApiError.internal()
                : ApiError.internal((error as Error).message || '服务内部错误');
            if (apiError.retryAfterSec) reply.header('Retry-After', String(apiError.retryAfterSec));
            return reply.status(apiError.status).send(errorBody(safe, String(request.id)));
        }
        if (apiError.status >= 500) request.log.warn({err: error, code: apiError.code}, 'request failed');
        if (apiError.retryAfterSec) reply.header('Retry-After', String(apiError.retryAfterSec));
        return reply.status(apiError.status).send(errorBody(apiError, String(request.id)));
    });
}
