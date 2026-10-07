/**
 * 服务器实例类型（独立文件，避免 swagger/server 之间出现循环依赖）。
 *
 * `ZodTypeProvider` 让路由 schema 同时提供「运行时校验 + 静态类型」；
 * 日志类型固定为 `FastifyBaseLogger`，这样各模块之间传递实例不会因为
 * pino 的具体类型而不兼容。
 */
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {FastifyBaseLogger, FastifyInstance, RawServerDefault} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';

export type GentlyInstance = FastifyInstance<
    RawServerDefault,
    IncomingMessage,
    ServerResponse,
    FastifyBaseLogger,
    ZodTypeProvider
>;
