/**
 * 单文件静态网页壁纸的安全包装。
 *
 * 网页壁纸是不可信内容：iframe 用空 `sandbox`（脚本 / 表单 / 同源 / 顶层导航全部关闭），
 * 再加一层 CSP，禁止脚本、网络、表单、子框架、对象与 base；只允许内联样式和
 * data:/blob: 资源。包装层还会去掉全部 `meta` / `base`，包括实体编码的 `meta refresh`。
 *
 * 为什么不做带 JS 的网页：iframe 沙箱挡不住脚本把自身导航到外网，CSP 的导航指令
 * 不可依赖；完整 JS Web 壁纸需要独立 WebView + 原生导航拦截（见 docs/GOTCHAS.md #14）。
 */
const CSP = [
    "default-src 'none'",
    // 静态网页壁纸：脚本不执行（iframe 沙箱里也无法执行），只允许内联样式与 data:/blob: 资源
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

export function wrapWebWallpaper(html: string): string {
    /*
     * 静态 HTML 不需要 meta/base；整段去掉，既防 meta refresh，也防实体编码绕过
     * （例如 http-equiv="ref&#114;esh"）。即使引号里带 `>` 让正则只吃掉前缀，
     * 剩下的也已经是普通文本，不再构成 meta 标签。
     */
    const staticHtml = html
        .replace(/<meta\b[^>]*>/gi, '')
        .replace(/<base\b[^>]*>/gi, '');
    return [
        '<!doctype html>',
        '<html><head><meta charset="utf-8">',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
        '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}*{box-sizing:border-box}</style>',
        '</head><body>',
        staticHtml,
        '</body></html>',
    ].join('');
}
