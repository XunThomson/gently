import type {TFunction} from 'i18next';
import type {CoreError} from '../api';

/**
 * 错误码 → 面向用户的文案。
 *
 * 契约把 `message` 定义为**面向开发者**的说明（可以带字段名、上游原文），
 * 因此界面不能直接把它当文案展示——否则英文界面里会冒出中文、
 * 用户也会看到「details」「sha256」这类内部词。
 *
 * 映射规则：错误码里的点号换成下划线（`common.not_found` → `errors.common_not_found`），
 * 这样 i18next 的 `keySeparator` 不会把它当成嵌套路径。
 * 26 个错误码在 `src/i18n/locales/{zh,en}.json` 里**全覆盖**，由冒烟测试守卫。
 */
export function errorKey(code: string): string {
    return `errors.${code.replace(/\./g, '_')}`;
}

/** 取本地化文案；万一某个码漏了翻译，退回核心的开发者说明而不是显示键名。 */
export function errorText(t: TFunction, error: Pick<CoreError, 'code' | 'message'>): string {
    const key = errorKey(error.code);
    const text = t(key);
    return text === key ? error.message : text;
}
