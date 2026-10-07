/**
 * 响应封装：所有路由**只能**通过这里产出响应体，保证信封一致。
 *
 * - `ok()` / `fail()` 生成 `ApiResult` 形状；
 * - `notImplemented` 是契约占位端点的统一响应（501）；
 * - 状态码取自 `ApiError.status`，路由不手写数字。
 */
import type {FastifyReply, FastifyRequest, RouteHandlerMethod} from 'fastify';
import {NOT_IMPLEMENTED} from '../contracts/endpoints.js';
import {ERROR_CODES, ERROR_STATUS, type ApiErrorDto} from '../contracts/primitives.js';
import {ApiError, errorBody} from './errors.js';

export interface OkBody<T> {
    ok: true;
    data: T;
    requestId: string;
}

export interface FailBody {
    ok: false;
    error: ApiErrorDto;
    requestId: string;
}

/** 请求 id：贯穿日志、响应与前端埋点 */
export const requestIdOf = (request: FastifyRequest): string => String(request.id);

export function ok<T>(data: T, requestId: string): OkBody<T> {
    return {ok: true, data, requestId};
}

export function fail(error: ApiErrorDto, requestId: string): FailBody {
    return {ok: false, error, requestId};
}

/** 契约已定义、业务未实现：客户端据此区分 404（没有该接口） */
export function notImplemented(requestId: string): FailBody {
    return fail({code: NOT_IMPLEMENTED.code, message: NOT_IMPLEMENTED.message}, requestId);
}

export function sendOk<T>(reply: FastifyReply, data: T, requestId: string, status = 200): FastifyReply {
    return reply.status(status).send(ok(data, requestId));
}

export function sendError(reply: FastifyReply, error: ApiError, requestId: string): FastifyReply {
    if (error.retryAfterSec) reply.header('Retry-After', String(error.retryAfterSec));
    return reply.status(error.status).send(errorBody(error, requestId));
}

/**
 * 未实现端点的处理器。
 *
 * 业务实现接入时，把 `stub` 换成真实处理器即可，**schema 与路由声明保持不变**，
 * 这样 OpenAPI 文档和前端契约在整个过程中始终有效。
 */
export const notImplementedHandler: RouteHandlerMethod = (request, reply) =>
    reply.status(ERROR_STATUS[ERROR_CODES.notImplemented]).send(notImplemented(requestIdOf(request)));
