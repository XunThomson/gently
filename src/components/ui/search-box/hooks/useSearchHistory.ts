/* ==================== hooks/useSearchHistory.ts ==================== */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    pushHistory,
    readHistory,
    removeHistory,
    writeHistory,
} from '../utils';

/**
 * 搜索历史管理（localStorage 持久化）
 */
export function useSearchHistory(
    historyKey: string | null,
    maxHistory: number
) {
    const [history, setHistory] = useState<string[]>(() =>
        readHistory(historyKey, maxHistory)
    );

    const keyRef = useRef(historyKey);
    const maxRef = useRef(maxHistory);

    // key 或 maxHistory 变化时重新读取
    useEffect(() => {
        keyRef.current = historyKey;
        maxRef.current = maxHistory;
        setHistory(readHistory(historyKey, maxHistory));
    }, [historyKey, maxHistory]);

    /** 添加一条记录（去重、置顶） */
    const add = useCallback((keyword: string) => {
        setHistory((prev) => {
            const next = pushHistory(prev, keyword, maxRef.current);
            writeHistory(keyRef.current, next);
            return next;
        });
    }, []);

    /** 删除单条 */
    const remove = useCallback((keyword: string) => {
        setHistory((prev) => {
            const next = removeHistory(prev, keyword);
            writeHistory(keyRef.current, next);
            return next;
        });
    }, []);

    /** 清空全部 */
    const clear = useCallback(() => {
        setHistory([]);
        writeHistory(keyRef.current, []);
    }, []);

    return { history, add, remove, clear };
}
