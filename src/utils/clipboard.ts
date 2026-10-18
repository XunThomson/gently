/**
 * 复制纯文本到剪贴板。
 *
 * 为什么不是直接 `navigator.clipboard.writeText`：桌面宿主里那条 API 只在**聚焦的**文档上生效，
 * 而我们的「导出皮肤」按钮点击时焦点就在文档里——但窗口刚恢复/被脚本驱动时可能不在，
 * 于是再加一条 `execCommand('copy')` 兜底路径（选中临时 textarea 再复制）。
 *
 * 返回是否成功：调用方据此决定提示语（失败时把内容摊开给用户手动复制，而不是假装成功）。
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* 继续试兜底路径 */
    }

    if (typeof document === 'undefined') return false;
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        /* 放到视口外：复制期间不该闪一下或改变滚动位置 */
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
    } catch {
        return false;
    }
}
