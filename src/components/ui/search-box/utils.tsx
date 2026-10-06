/* ==================== utils.tsx ==================== */
import type React from 'react';
import type { GroupItem } from './types';

/** 合并 className */
export const cx = (...args: Array<string | false | null | undefined>) =>
    args.filter(Boolean).join(' ');

/** 从 localStorage 读取历史 */
export function readHistory(key: string | null, max: number): string[] {
    if (!key || typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(key);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.slice(0, max) : [];
    } catch {
        return [];
    }
}

/** 写入 localStorage 历史 */
export function writeHistory(key: string | null, list: string[]): void {
    if (!key || typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(key, JSON.stringify(list));
    } catch {
        /* 忽略写入失败（隐私模式/配额） */
    }
}

/** 将关键词插入历史首位并去重 */
export function pushHistory(
    prev: string[],
    keyword: string,
    max: number
): string[] {
    return [keyword, ...prev.filter((v) => v !== keyword)].slice(0, max);
}

/** 从历史中移除某项 */
export function removeHistory(prev: string[], keyword: string): string[] {
    return prev.filter((v) => v !== keyword);
}

/**
 * 关键词高亮
 * @param text        原始文本
 * @param keyword     高亮关键词
 * @param hlClassName 高亮节点样式类（由调用方从 CSS Module 传入，避免 utils 依赖样式模块）
 */
export function highlight(
    text: string,
    keyword: string,
    hlClassName?: string
): React.ReactNode {
    if (!keyword) return text;
    const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
    if (idx < 0) return text;
    return (
        <>
            {text.slice(0, idx)}
            <mark className={hlClassName}>
                {text.slice(idx, idx + keyword.length)}
            </mark>
            {text.slice(idx + keyword.length)}
        </>
    );
}

/** 静态数据源本地过滤 */
export function filterSuggestions(
    list: GroupItem[],
    keyword: string
): GroupItem[] {
    const lower = keyword.toLowerCase();
    return list.filter((s) =>
        (s.label ?? s.value).toLowerCase().includes(lower)
    );
}
