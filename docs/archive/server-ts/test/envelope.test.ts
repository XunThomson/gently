/**
 * 信封一致性守卫。
 *
 * 背景：所有接口的成功响应必须是统一信封 `{ok, data, requestId}`。
 * 单看路由文件很容易漏包一层（`200: playlistSchema` 而不是 `resultSchema(playlistSchema)`），
 * 编译器不会报错，前端却会在解析时炸掉。
 *
 * 这里从**生成的 OpenAPI** 反查：只要某个 2xx 响应不是信封形状就失败，
 * 并直接给出 operationId，便于定位。
 */
import {afterAll, describe, expect, it} from 'vitest';
import {ENDPOINTS} from '../src/contracts/endpoints.js';
import {makeApp} from './helpers.js';

interface JsonSchema {
    anyOf?: JsonSchema[];
    properties?: Record<string, JsonSchema>;
    required?: string[];
    enum?: unknown[];
    type?: string;
}

interface ResponseSpec {
    content?: Record<string, {schema?: JsonSchema}>;
}

interface Operation {
    responses?: Record<string, ResponseSpec>;
}

interface OpenApiDoc {
    paths: Record<string, Record<string, Operation>>;
}

const app = await makeApp();
await app.ready();
const spec = app.swagger() as unknown as OpenApiDoc;
afterAll(async () => {
    await app.close();
});

const schemaOf = (response?: ResponseSpec): JsonSchema | undefined =>
    response?.content?.['application/json']?.schema;

/** 成功信封：`{ok: true, data, requestId}`（也可能是含该分支的 union） */
function isSuccessEnvelope(schema?: JsonSchema): boolean {
    if (!schema) return false;
    const variants = schema.anyOf ?? [schema];
    return variants.some((variant) => {
        const ok = variant.properties?.['ok'];
        if (!ok) return false;
        const okIsTrue = Array.isArray(ok.enum) && ok.enum.includes(true);
        const hasData = variant.properties?.['data'] !== undefined;
        const hasRequestId = variant.properties?.['requestId'] !== undefined;
        return okIsTrue && hasData && hasRequestId;
    });
}

/** 失败信封：`{ok: false, error, requestId}` */
function isErrorEnvelope(schema?: JsonSchema): boolean {
    if (!schema) return false;
    const variants = schema.anyOf ?? [schema];
    return variants.some((variant) => {
        const ok = variant.properties?.['ok'];
        const okIsFalse = Array.isArray(ok?.enum) && ok.enum.includes(false);
        return (
            variant.properties?.['error'] !== undefined &&
            variant.properties?.['requestId'] !== undefined &&
            (okIsFalse || ok?.type === 'boolean')
        );
    });
}

const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({id: `${method.toUpperCase()} ${path}`, operation})),
);

describe('响应信封一致性（基于生成的 OpenAPI）', () => {
    it('文档里存在接口（否则守卫形同虚设）', () => {
        expect(operations.length).toBeGreaterThanOrEqual(ENDPOINTS.length - 1);
    });

    it('每个 2xx 响应都是统一信封 `{ok, data, requestId}`', () => {
        const violations = operations
            .flatMap(({id, operation}) =>
                Object.entries(operation.responses ?? {})
                    .filter(([status]) => status.startsWith('2'))
                    .map(([status, response]) => ({id: `${id} → ${status}`, schema: schemaOf(response)})),
            )
            .filter(({schema}) => !isSuccessEnvelope(schema))
            .map(({id}) => id);

        expect(violations).toEqual([]);
    });

    it('每个 4xx / 5xx 响应都是失败信封 `{ok:false, error, requestId}`', () => {
        const violations = operations
            .flatMap(({id, operation}) =>
                Object.entries(operation.responses ?? {})
                    .filter(([status]) => /^[45]/.test(status))
                    .map(([status, response]) => ({id: `${id} → ${status}`, schema: schemaOf(response)})),
            )
            .filter(({schema}) => !isErrorEnvelope(schema))
            .map(({id}) => id);

        expect(violations).toEqual([]);
    });

    it('清单里每个端点都在文档中（WebSocket 通道除外）', () => {
        const known = new Set(ENDPOINTS.map((e) => `${e.method} ${e.path.replace(/:([A-Za-z]+)/g, '{$1}')}`));
        const documented = new Set(operations.map(({id}) => id));
        const missing = [...known].filter((k) => !documented.has(k));
        expect(missing).toEqual([]);
    });
});
