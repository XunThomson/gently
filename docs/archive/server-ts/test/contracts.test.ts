/**
 * 契约层单元测试：清单不变量 + 信封 / 分页 / 错误映射。
 *
 * 这些是**客户端可以依赖的最底层承诺**（形状与状态码），一旦破坏，
 * 前端生成的调用代码与错误分支会静默失效，因此用纯函数测试钉死。
 * 不经过 HTTP，避免把契约问题和路由问题混在一起。
 */
import {describe, expect, test} from 'vitest';
import {ENDPOINTS} from '../src/contracts/endpoints.js';
import {ERROR_CODES, ERROR_STATUS, type ErrorCode} from '../src/contracts/primitives.js';
import {ApiError, toApiError} from '../src/http/errors.js';
import {buildPage, decodeCursor, encodeCursor} from '../src/http/pagination.js';
import {fail, notImplemented, ok} from '../src/http/result.js';

describe('接口清单不变量', () => {
    test('id 唯一（OpenAPI operationId 与前端代码生成都依赖它）', () => {
        const ids = ENDPOINTS.map((spec) => spec.id);
        const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
        expect(duplicated, `重复的端点 id：${duplicated.join(', ')}`).toEqual([]);
    });

    test('path 以 / 开头（相对路径会让 fastify 注册失败）', () => {
        const invalid = ENDPOINTS.filter((spec) => !spec.path.startsWith('/')).map((spec) => spec.id);
        expect(invalid, `路径未以 / 开头：${invalid.join(', ')}`).toEqual([]);
    });

    test('idempotent 蕴涵 auth（幂等键按用户隔离，匿名写没有作用域）', () => {
        const invalid = ENDPOINTS.filter((spec) => spec.idempotent === true && !spec.auth).map((spec) => spec.id);
        expect(invalid, `幂等但未要求鉴权：${invalid.join(', ')}`).toEqual([]);
    });

    test('tag 非空（OpenAPI 分组与文档顺序依赖它）', () => {
        const invalid = ENDPOINTS.filter((spec) => spec.tag.trim().length === 0).map((spec) => spec.id);
        expect(invalid, `缺少 tag：${invalid.join(', ')}`).toEqual([]);
    });

    test('ERROR_STATUS 覆盖全部 ERROR_CODES（漏一个就会让错误映射在运行期取到 undefined）', () => {
        const codes = Object.values(ERROR_CODES) as ErrorCode[];
        const missing = codes.filter((code) => typeof ERROR_STATUS[code] !== 'number');
        expect(missing, `缺少状态码映射：${missing.join(', ')}`).toEqual([]);
    });
});

describe('响应信封', () => {
    test('ok() 形状', () => {
        expect(ok({value: 1}, 'req-1')).toEqual({ok: true, data: {value: 1}, requestId: 'req-1'});
    });

    test('fail() 形状：错误体不含 details 时不下发空对象', () => {
        expect(fail({code: ERROR_CODES.notFound, message: '没有'}, 'req-2')).toEqual({
            ok: false,
            error: {code: ERROR_CODES.notFound, message: '没有'},
            requestId: 'req-2',
        });
    });

    test('notImplemented() 使用契约占位错误码', () => {
        const body = notImplemented('req-3');
        expect(body.ok).toBe(false);
        expect(body.error.code).toBe(ERROR_CODES.notImplemented);
        expect(body.requestId).toBe('req-3');
    });
});

describe('游标分页', () => {
    test('encodeCursor / decodeCursor 往返一致', () => {
        const parts = {key: 1_700_000_000_000, id: 'mock:1'};
        expect(decodeCursor(encodeCursor(parts))).toEqual(parts);
        // 游标是 base64url：不应出现需要 URL 转义的字符
        expect(encodeCursor(parts)).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test('非法游标抛 common.invalid_argument（而不是静默忽略）', () => {
        const attempts = ['这根本不是游标', Buffer.from(JSON.stringify({key: 1})).toString('base64url')];
        for (const cursor of attempts) {
            try {
                decodeCursor(cursor);
                throw new Error(`应当抛出 ApiError：${cursor}`);
            } catch (err) {
                expect(err).toBeInstanceOf(ApiError);
                expect((err as ApiError).code).toBe(ERROR_CODES.invalidArgument);
            }
        }
    });

    test('buildPage：多取一条时给出 nextCursor 且只返回 limit 条', () => {
        const rows = [1, 2, 3];
        const page = buildPage(rows, 2, (row) => ({key: row, id: `item-${row}`}));
        expect(page.items).toEqual([1, 2]);
        expect(page.items.length).toBe(2);
        expect(page.hasMore).toBe(true);
        expect(page.nextCursor).toBeDefined();
        // nextCursor 必须指回「本页最后一条」，否则翻页会漏数据
        expect(decodeCursor(page.nextCursor ?? '')).toEqual({key: 2, id: 'item-2'});
    });

    test('buildPage：不足 limit 时为末页（无 nextCursor，hasMore=false）', () => {
        const page = buildPage([1], 2, (row) => ({key: row, id: `item-${row}`}));
        expect(page.items).toEqual([1]);
        expect(page.hasMore).toBe(false);
        expect(page.nextCursor).toBeUndefined();
    });

    test('buildPage：total 仅在传入时返回（前端不需要「共 N 条」时不额外查询）', () => {
        expect(buildPage([1], 2, (row) => ({key: row, id: `${row}`})).total).toBeUndefined();
        expect(buildPage([1], 2, (row) => ({key: row, id: `${row}`}), 10).total).toBe(10);
    });
});

describe('错误映射', () => {
    test('未知异常 → common.internal 且标记 unexpected（由调用方决定是否记日志/脱敏）', () => {
        const {apiError, unexpected} = toApiError(new Error('x'));
        expect(apiError.code).toBe(ERROR_CODES.internal);
        expect(unexpected).toBe(true);
    });

    test('ApiError.notFound() → 404 且 unexpected=false（属于预期业务错误）', () => {
        const {apiError, unexpected} = toApiError(ApiError.notFound());
        expect(apiError.code).toBe(ERROR_CODES.notFound);
        expect(apiError.status).toBe(404);
        expect(unexpected).toBe(false);
    });
});
