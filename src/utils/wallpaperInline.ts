import {appConfig} from '../config/app.config';

/**
 * 单文件网页壁纸的「准备」工具：把用户自己选的静态网页目录内联成一个 HTML。
 *
 * 设计边界（与 `backgroundWeb.ts` 一致）：
 * - **不执行任何脚本**：`<script>` 直接移除；CSS 动画保留；
 * - **不联网**：外部 CSS/图片/字体不会留下可加载的引用；能读取的本机资源转 data URI，
 *   读不到的外部地址移除并提示；
 * - **只处理用户显式选择的文件**：不扫描目录、不猜路径、不读取选择范围之外的文件；
 * - 输出仍受 `appConfig.background.maxWebBytes` 限制，避免把内存/IndexedDB 撑爆。
 */

export interface InlineWebResult {
    html: string;
    entry: string;
    bytes: number;
    files: number;
    inlined: number;
    removedScripts: number;
    removedExternal: number;
    warnings: string[];
}

export const MAX_INLINE_FILES = 300;
export const MAX_INLINE_INPUT_BYTES = 50 * 1024 * 1024;

const ASSET_SCHEME = /^(?:data|blob|javascript|mailto|tel):/i;
const EXTERNAL_SCHEME = /^(?:https?:)?\/\//i;

function stripQueryAndHash(value: string): string {
    const hash = value.indexOf('#');
    const withoutHash = hash >= 0 ? value.slice(0, hash) : value;
    const query = withoutHash.indexOf('?');
    return query >= 0 ? withoutHash.slice(0, query) : withoutHash;
}

/** 把目录里的相对路径归一化；绝对路径、协议地址、逃出根目录的 `..` 一律拒绝。 */
export function normalizeWebPath(input: string): string | null {
    if (!input) return null;
    let value = input.replace(/\\/g, '/').trim();
    if (!value || value.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
    value = stripQueryAndHash(value);
    try {
        value = decodeURIComponent(value);
    } catch {
        /* 保留原始值：坏转义不应让整个目录失败 */
    }

    const parts: string[] = [];
    for (const segment of value.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (parts.length === 0) return null;
            parts.pop();
        } else {
            parts.push(segment);
        }
    }
    return parts.length > 0 ? parts.join('/') : null;
}

/** 以 `basePath`（它所在目录）解析一个资源引用；外部地址 / data / 锚点返回 null。 */
export function resolveWebAssetPath(basePath: string, reference: string): string | null {
    const raw = reference.trim();
    if (!raw || raw.startsWith('#') || ASSET_SCHEME.test(raw) || EXTERNAL_SCHEME.test(raw)) {
        return null;
    }
    const baseDir = basePath.includes('/')
        ? basePath.slice(0, basePath.lastIndexOf('/') + 1)
        : '';
    return normalizeWebPath(baseDir + stripQueryAndHash(raw));
}

export function isExternalAssetRef(reference: string): boolean {
    return EXTERNAL_SCHEME.test(reference.trim());
}

/** 读取为 data URI；File.type 为空时按扩展名补，避免 WebView 猜成 octet-stream。 */
export function readFileAsDataUri(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : '';
            if (!result) {
                reject(new Error('empty file'));
                return;
            }
            const inferred = file.type || mimeFromPath(file.name);
            if (inferred && result.startsWith('data:application/octet-stream')) {
                resolve(`data:${inferred};base64,${result.slice(result.indexOf(',') + 1)}`);
            } else {
                resolve(result);
            }
        };
        reader.readAsDataURL(file);
    });
}

function mimeFromPath(path: string): string {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const table: Record<string, string> = {
        html: 'text/html',
        htm: 'text/html',
        css: 'text/css',
        js: 'text/javascript',
        json: 'application/json',
        svg: 'image/svg+xml',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        avif: 'image/avif',
        ico: 'image/x-icon',
        woff: 'font/woff',
        woff2: 'font/woff2',
        ttf: 'font/ttf',
        otf: 'font/otf',
        mp3: 'audio/mpeg',
        mp4: 'video/mp4',
        webm: 'video/webm',
        ogg: 'audio/ogg',
        wav: 'audio/wav',
    };
    return table[ext] ?? 'application/octet-stream';
}

function bytesOf(text: string): number {
    return new TextEncoder().encode(text).length;
}

/**
 * 把 CSS 里的 `url(...)` 换成本机 data URI。同步/异步 resolver 都支持；
 * 解析不到的引用替换成空 data URI，避免留下一个 CSP 会拦的外部请求。
 */
export async function rewriteCssAssets(
    css: string,
    basePath: string,
    resolveAsset: (path: string) => Promise<string | null> | string | null,
): Promise<{css: string; inlined: number; removedExternal: number; warnings: string[]}> {
    let inlined = 0;
    let removedExternal = 0;
    const warnings: string[] = [];

    /* @import 会从外部再拉一份样式；静态单文件不做递归展开，直接移除并提示 */
    let source = css.replace(
        /@import\s+(?:url\(\s*(['"]?)[^)]+\1\s*\)|['"][^'"]+['"])\s*[^;]*;/gi,
        () => {
            warnings.push('css-import-removed');
            return '/* @import removed by gently */';
        },
    );

    const pattern = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^'")]+))\s*\)/gi;
    let result = '';
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
        const reference = (match[1] ?? match[2] ?? match[3] ?? '').trim();
        result += source.slice(last, match.index);
        last = pattern.lastIndex;

        if (!reference || reference.startsWith('#') || ASSET_SCHEME.test(reference)) {
            result += match[0];
            continue;
        }
        if (isExternalAssetRef(reference)) {
            removedExternal += 1;
            result += 'url("data:,")';
            continue;
        }

        const resolved = resolveWebAssetPath(basePath, reference);
        const data = resolved ? await resolveAsset(resolved) : null;
        if (data) {
            inlined += 1;
            result += `url("${data}")`;
        } else {
            removedExternal += 1;
            warnings.push('css-asset-missing');
            result += 'url("data:,")';
        }
    }
    result += source.slice(last);
    source = result;
    return {css: source, inlined, removedExternal, warnings};
}

/** 浏览器内把选中的静态网页目录打包成一个 HTML；调用前必须由用户显式选择文件。 */
export async function inlineWebWallpaper(
    files: File[],
    entryPath?: string,
): Promise<InlineWebResult> {
    if (files.length > MAX_INLINE_FILES) throw new Error('too-many-files');
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_INLINE_INPUT_BYTES) {
        throw new Error('input-too-large');
    }

    const byPath = new Map<string, File>();
    for (const file of files) {
        const relative = (file as File & {webkitRelativePath?: string}).webkitRelativePath || file.name;
        const normalized = normalizeWebPath(relative);
        if (normalized) byPath.set(normalized, file);
    }

    const htmlFiles = [...byPath.keys()].filter((path) => /\.(?:html?|xhtml)$/i.test(path));
    const picked =
        (entryPath && byPath.has(entryPath) ? entryPath : null) ??
        htmlFiles.find((path) => /(^|\/)index\.html?$/i.test(path)) ??
        htmlFiles[0];
    if (!picked) throw new Error('no-html');

    const entryFile = byPath.get(picked);
    if (!entryFile) throw new Error('no-html');
    const source = await entryFile.text();

    if (typeof DOMParser === 'undefined') throw new Error('no-dom');
    const doc = new DOMParser().parseFromString(source, 'text/html');

    let removedScripts = 0;
    let removedExternal = 0;
    let inlined = 0;
    const warnings: string[] = [];

    for (const element of [...doc.querySelectorAll('script')]) {
        removedScripts += 1;
        element.remove();
    }
    for (const element of [
        ...doc.querySelectorAll('iframe, object, embed, frame, frameset, base, meta'),
    ]) {
        element.remove();
    }

    const readAsset = async (path: string): Promise<string | null> => {
        const file = byPath.get(path);
        if (!file) return null;
        return readFileAsDataUri(file);
    };

    /* <link rel=stylesheet>：读本地 CSS、内联其 url() 后再放回 <style>，保持层叠顺序 */
    for (const link of [...doc.querySelectorAll('link')]) {
        const rel = (link.getAttribute('rel') ?? '').toLowerCase();
        const href = link.getAttribute('href') ?? '';
        if (!rel.split(/\s+/).includes('stylesheet') || !href) {
            link.remove();
            continue;
        }
        const path = resolveWebAssetPath(picked, href);
        const cssFile = path ? byPath.get(path) : undefined;
        if (!cssFile) {
            removedExternal += 1;
            link.remove();
            continue;
        }
        const css = await cssFile.text();
        const rewritten = await rewriteCssAssets(css, path!, readAsset);
        inlined += rewritten.inlined;
        removedExternal += rewritten.removedExternal;
        warnings.push(...rewritten.warnings);
        const style = doc.createElement('style');
        const media = link.getAttribute('media');
        if (media) style.setAttribute('media', media);
        style.textContent = rewritten.css;
        link.replaceWith(style);
    }

    const rewriteStyle = async (style: Element) => {
        const rewritten = await rewriteCssAssets(style.textContent ?? '', picked, readAsset);
        style.textContent = rewritten.css;
        inlined += rewritten.inlined;
        removedExternal += rewritten.removedExternal;
        warnings.push(...rewritten.warnings);
    };
    for (const style of [...doc.querySelectorAll('style')]) await rewriteStyle(style);

    for (const element of [...doc.querySelectorAll('[style]')]) {
        const value = element.getAttribute('style') ?? '';
        if (!value) continue;
        const rewritten = await rewriteCssAssets(value, picked, readAsset);
        element.setAttribute('style', rewritten.css);
        inlined += rewritten.inlined;
        removedExternal += rewritten.removedExternal;
        warnings.push(...rewritten.warnings);
    }

    const inlineAttribute = async (element: Element, attribute: string) => {
        const value = element.getAttribute(attribute);
        if (!value) return;
        if (ASSET_SCHEME.test(value)) return;
        if (isExternalAssetRef(value)) {
            element.removeAttribute(attribute);
            removedExternal += 1;
            warnings.push('external-asset-removed');
            return;
        }
        const path = resolveWebAssetPath(picked, value);
        const data = path ? await readAsset(path) : null;
        if (data) {
            element.setAttribute(attribute, data);
            inlined += 1;
        } else {
            element.removeAttribute(attribute);
            removedExternal += 1;
            warnings.push('asset-missing');
        }
    };

    for (const image of [...doc.querySelectorAll('img')]) {
        if (image.hasAttribute('srcset')) {
            image.removeAttribute('srcset');
            warnings.push('srcset-simplified');
        }
        await inlineAttribute(image, 'src');
    }
    for (const input of [...doc.querySelectorAll('input[type="image"]')]) {
        await inlineAttribute(input, 'src');
    }
    for (const source of [...doc.querySelectorAll('source')]) {
        if (source.hasAttribute('srcset')) {
            source.removeAttribute('srcset');
            warnings.push('srcset-simplified');
        }
        await inlineAttribute(source, 'src');
    }
    for (const media of [...doc.querySelectorAll('video, audio')]) {
        await inlineAttribute(media, 'src');
    }
    for (const video of [...doc.querySelectorAll('video')]) await inlineAttribute(video, 'poster');
    for (const image of [...doc.querySelectorAll('image')]) {
        await inlineAttribute(image, 'href');
        await inlineAttribute(image, 'xlink:href');
    }
    for (const form of [...doc.querySelectorAll('form')]) form.remove();
    /* 内联事件属性没有执行通道（CSP script-src none），但仍然删掉，避免误导作者 */
    for (const element of [...doc.querySelectorAll('*')]) {
        for (const attribute of [...element.attributes]) {
            if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
        }
    }

    const html = `${doc.head.innerHTML}${doc.body.innerHTML}`;
    const bytes = bytesOf(html);
    /* 留出包装层 CSP/style 的余量：保存时还会套一层 wrapper */
    if (bytes > appConfig.background.maxWebBytes - 4096) throw new Error('output-too-large');

    return {
        html,
        entry: picked,
        bytes,
        files: byPath.size,
        inlined,
        removedScripts,
        removedExternal,
        warnings: [...new Set(warnings)],
    };
}
