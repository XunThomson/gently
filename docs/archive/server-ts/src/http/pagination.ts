/**
 * 游标分页：解析 / 生成不透明游标。
 *
 * 为什么不用 offset：榜单、收藏、最近播放都会在翻页期间变化，
 * offset 会重复或漏掉条目；游标指向「上一页最后一条」的稳定键。
 *
 * 游标对客户端是**不透明字符串**，实现可以随时更换（例如从 base64 JSON
 * 换成数据库 keyset 编码），只要保证同版本内自洽。
 */
import {ApiError} from './errors.js';

export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 30;

export interface CursorParts {
    /** 排序键，如时间戳或热度 */
    key: string | number;
    /** 稳定 tie-breaker，通常是记录 id */
    id: string;
}

/** 生成游标（base64url，避免出现在 URL 里需要转义的字符） */
export function encodeCursor(parts: CursorParts): string {
    return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/** 解析游标；非法游标抛 `common.invalid_argument` 而不是静默忽略 */
export function decodeCursor(cursor: string): CursorParts {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
        throw ApiError.invalidArgument('cursor 不是合法的游标');
    }
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('id' in parsed) ||
        !('key' in parsed) ||
        (typeof (parsed as CursorParts).key !== 'string' && typeof (parsed as CursorParts).key !== 'number') ||
        typeof (parsed as CursorParts).id !== 'string'
    ) {
        throw ApiError.invalidArgument('cursor 结构不正确');
    }
    return parsed as CursorParts;
}

export interface PageDto<T> {
    items: T[];
    nextCursor?: string;
    hasMore: boolean;
    total?: number;
}

/**
 * 由「已多取一条」的结果集构造分页。
 *
 * 调用方按 `limit + 1` 取值：多出的那条只用于判断 `hasMore`，
 * 不返回给客户端（否则前端会看到第 limit+1 条）。
 */
export function buildPage<T>(rows: T[], limit: number, cursorOf: (row: T) => CursorParts, total?: number): PageDto<T> {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
        items,
        ...(hasMore && last ? {nextCursor: encodeCursor(cursorOf(last))} : {}),
        hasMore,
        ...(total === undefined ? {} : {total}),
    };
}

/** 归一化 limit（schema 已校验，这里兜住服务内部调用） */
export function normalizeLimit(limit?: number): number {
    if (limit === undefined) return DEFAULT_LIMIT;
    return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}
