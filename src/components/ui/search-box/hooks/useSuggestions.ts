/* ==================== hooks/useSuggestions.ts ==================== */
import { useEffect, useRef, useState } from 'react';
import { filterSuggestions } from '../utils';
import type { SearchSuggestion, SuggestionSource } from '../types';

/**
 * 联想数据获取
 * - 支持静态数组 / 异步函数
 * - 内置防抖
 * - 竞态保护（旧请求结果丢弃）
 */
export function useSuggestions(
    keyword: string,
    source: SuggestionSource | undefined,
    debounce: number
) {
    const [list, setList] = useState<SearchSuggestion[]>([]);
    const [loading, setLoading] = useState(false);

    // 用 ref 持有 source，避免父组件行内函数导致重复请求
    const sourceRef = useRef(source);
    sourceRef.current = source;

    useEffect(() => {
        const src = sourceRef.current;

        // 无关键词 或 无数据源：清空
        if (!keyword || !src) {
            setList([]);
            setLoading(false);
            return;
        }

        let aborted = false;
        setLoading(true);

        const timer = window.setTimeout(async () => {
            try {
                const res = Array.isArray(src)
                    ? filterSuggestions(src, keyword)
                    : await src(keyword);
                if (!aborted) setList(res ?? []);
            } catch {
                if (!aborted) setList([]);
            } finally {
                if (!aborted) setLoading(false);
            }
        }, debounce);

        return () => {
            aborted = true;
            window.clearTimeout(timer);
        };
    }, [keyword, debounce]);

    return { list, loading };
}
