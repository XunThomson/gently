/* ==================== types.ts ==================== */
import type React from 'react';

export interface SearchSuggestion {
    /** 实际用于搜索的值 */
    value: string;
    /** 展示文案，默认取 value */
    label?: string;
    /** 辅助说明，如分类、数量 */
    desc?: string;
}

/** 联想数据源：静态数组 或 异步函数 */
export type SuggestionSource =
    | SearchSuggestion[]
    | ((keyword: string) => SearchSuggestion[] | Promise<SearchSuggestion[]>);

export interface SearchBoxProps {
    /** 受控值 */
    value?: string;
    defaultValue?: string;
    placeholder?: string;
    /** 联想数据源 */
    suggestions?: SuggestionSource;
    /** 热门搜索词 */
    hotWords?: string[];
    /** 历史记录 localStorage key；传 null 关闭历史功能 */
    historyKey?: string | null;
    maxHistory?: number;
    /** focus：聚焦即展开；input：有输入才展开 */
    openMode?: 'focus' | 'input';
    /** 联想防抖，毫秒 */
    debounce?: number;
    autoFocus?: boolean;
    submitText?: string;
    className?: string;
    onSearch?: (keyword: string) => void;
    onChange?: (keyword: string) => void;
    onOpenChange?: (open: boolean) => void;
}

/** 面板分组 */
export interface GroupItem {
    value: string;
    label?: string;
    desc?: string;
}

export interface Group {
    key: 'suggestion' | 'history' | 'hot';
    title: string;
    items: GroupItem[];
    /** 该组首项在整个扁平列表中的索引 */
    offset: number;
}

export type IconProps = React.SVGProps<SVGSVGElement> & { size?: number };