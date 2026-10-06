/* ==================== index.ts ==================== */
export { default as SearchBox } from './SearchBox';
export { default } from './SearchBox';

export type {
    SearchBoxProps,
    SearchSuggestion,
    SuggestionSource,
} from './types';

// 可选：导出 hooks 供自定义复用
export { useControllableValue } from './hooks/useControllableValue';
export { useClickOutside } from './hooks/useClickOutside';
export { useSearchHistory } from './hooks/useSearchHistory';
export { useSuggestions } from './hooks/useSuggestions';
