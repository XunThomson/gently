import type {TFunction} from 'i18next';


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

/**
 * 这些码的 `message` 其实是**插件作者写给用户的**（抛错原文 / 拒绝原因），
 * 界面必须带上它，否则用户只能看到「插件执行出错」而无从下手。
 *
 * 典型例子（R68）：B 站插件的收藏夹需要登录，没有 Cookie 时它抛
 * 「需要登录：在插件设置里填写 B 站 Cookie（SESSDATA）后重试」——
 * 这条信息被吞掉之后，用户看到「插件执行出错」，完全不知道下一步做什么。
 */
const MESSAGE_IS_FOR_USER: ReadonlySet<string> = new Set([
    'plugin.runtime_error',
    'plugin.permission_denied',
    'plugin.invalid_source',
    'plugin.not_found',
]);

/** 取本地化文案；万一某个码漏了翻译，退回核心的开发者说明而不是显示键名。 */
export function errorText(t: TFunction, error: {code: string; message?: string}): string {
    const key = errorKey(error.code);
    const text = t(key);
    const base = text === key ? (error.message ?? '') : text;
    const message = error.message?.trim() ?? '';
    if (!MESSAGE_IS_FOR_USER.has(error.code) || !message) return base;
    if (base.includes(message)) return base;
    return `${base}：${message}`;
}


