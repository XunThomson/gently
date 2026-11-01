import {appConfig} from '../config/app.config';
import type {BackgroundAsset, WebAsset} from '../utils/backgroundSettings';

/**
 * 本地背景素材存储（IndexedDB）。
 *
 * - `videos`：用户导入的 mp4/webm Blob；
 * - `pages`：单文件网页壁纸的 HTML 文本；
 * - 不经过核心、不扩大文件系统权限，浏览器预览与桌面端同一条路径。
 *
 * 代价：清空 WebView 站点数据会丢背景；`reset` 时由 UI 调 `remove*` 清掉。
 */
const DB_NAME = 'gently-backgrounds';
const DB_VERSION = 2;
const VIDEO_STORE = 'videos';
const PAGE_STORE = 'pages';

export type BackgroundSaveError =
    | 'unsupported'
    | 'empty'
    | 'too-large'
    | 'unsupported-type'
    | 'storage';

export type BackgroundSaveResult =
    | {ok: true; asset: BackgroundAsset}
    | {ok: false; reason: BackgroundSaveError};

export type WebSaveResult =
    | {ok: true; web: WebAsset}
    | {ok: false; reason: BackgroundSaveError};

interface StoredVideo {
    id: string;
    blob: Blob;
}

interface StoredPage {
    id: string;
    html: string;
}

const VIDEO_EXT = /\.(mp4|webm|m4v|ogv|ogg)$/i;
const WEB_EXT = /\.(html?|xhtml)$/i;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') {
        return Promise.reject(new Error('indexedDB unavailable'));
    }
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(VIDEO_STORE)) {
                db.createObjectStore(VIDEO_STORE, {keyPath: 'id'});
            }
            if (!db.objectStoreNames.contains(PAGE_STORE)) {
                db.createObjectStore(PAGE_STORE, {keyPath: 'id'});
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
    });
    /* 打开失败后允许下一次重试，而不是永久持有 rejected promise */
    dbPromise.catch(() => {
        dbPromise = null;
    });
    return dbPromise;
}

function newId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isVideo(file: File): boolean {
    return file.type.startsWith('video/') || VIDEO_EXT.test(file.name);
}

function isWebPage(file: File): boolean {
    return file.type.startsWith('text/html') ||
        file.type === 'application/xhtml+xml' ||
        WEB_EXT.test(file.name);
}

async function put<T>(store: string, value: T): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB write aborted'));
    });
}

async function get<T>(store: string, id: string): Promise<T | undefined> {
    const db = await openDb();
    return await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const request = tx.objectStore(store).get(id);
        request.onsuccess = () => resolve(request.result as T | undefined);
        request.onerror = () => reject(request.error ?? new Error('indexedDB read failed'));
    });
}

async function hasKey(store: string, id: string): Promise<boolean> {
    const db = await openDb();
    return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const request = tx.objectStore(store).getKey(id);
        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => reject(request.error ?? new Error('indexedDB read failed'));
    });
}

async function removeKey(store: string, id: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'));
    });
}

export const backgroundService = {
    /**
     * 保存用户选择的视频。**先校验类型与大小**，再写 IndexedDB；
     * 任何失败都返回可翻译的原因，不抛异常。
     */
    async save(file: File, id?: string): Promise<BackgroundSaveResult> {
        if (typeof indexedDB === 'undefined') return {ok: false, reason: 'unsupported'};
        if (file.size <= 0) return {ok: false, reason: 'empty'};
        if (file.size > appConfig.background.maxVideoBytes) {
            return {ok: false, reason: 'too-large'};
        }
        if (!isVideo(file)) return {ok: false, reason: 'unsupported-type'};

        const asset: BackgroundAsset = {
            /* 显式 id 用于**主题包**：一套皮肤一份背景，换素材时覆盖同一个键，
               切主题就按 `skin:<id>` 找得到（见 utils/skinPackage） */
            id: id ?? newId(),
            name: file.name,
            size: file.size,
            type: file.type,
            importedAt: Date.now(),
        };
        try {
            await put<StoredVideo>(VIDEO_STORE, {id: asset.id, blob: file});
            return {ok: true, asset};
        } catch {
            return {ok: false, reason: 'storage'};
        }
    },

    /**
     * 保存单文件网页壁纸。只接受 HTML 文本；外部 CSS/JS/图片不会自动带入，
     * 需要用户自己内联（渲染端还会再加沙箱与 CSP）。
     */
    async saveWeb(file: File, id?: string): Promise<WebSaveResult> {
        if (typeof indexedDB === 'undefined') return {ok: false, reason: 'unsupported'};
        if (file.size <= 0) return {ok: false, reason: 'empty'};
        if (file.size > appConfig.background.maxWebBytes) {
            return {ok: false, reason: 'too-large'};
        }
        if (!isWebPage(file)) return {ok: false, reason: 'unsupported-type'};
        try {
            const html = await file.text();
            // 与 `save` 同理：主题包用固定 id 覆盖，一套皮肤一份网页背景
            const web: WebAsset = {id: id ?? newId(), name: file.name, size: file.size};
            await put<StoredPage>(PAGE_STORE, {id: web.id, html});
            return {ok: true, web};
        } catch {
            return {ok: false, reason: 'storage'};
        }
    },

    /** 读取视频 Blob；不存在/不可用时返回 null（调用方退回默认背景）。 */
    async load(id: string): Promise<Blob | null> {
        try {
            const value = await get<StoredVideo>(VIDEO_STORE, id);
            return value?.blob instanceof Blob ? value.blob : null;
        } catch {
            return null;
        }
    },

    async loadWeb(id: string): Promise<string | null> {
        try {
            const value = await get<StoredPage>(PAGE_STORE, id);
            return typeof value?.html === 'string' ? value.html : null;
        } catch {
            return null;
        }
    },

    /** 元数据还在但素材丢了（例如清过站点数据）：设置页据此提示重新导入。 */
    async has(id: string): Promise<boolean> {
        try {
            return await hasKey(VIDEO_STORE, id);
        } catch {
            return false;
        }
    },

    async hasWeb(id: string): Promise<boolean> {
        try {
            return await hasKey(PAGE_STORE, id);
        } catch {
            return false;
        }
    },

    async remove(id: string): Promise<void> {
        try {
            await removeKey(VIDEO_STORE, id);
        } catch {
            /* 清不掉只影响磁盘占用，不阻塞用户恢复默认 */
        }
    },

    async removeWeb(id: string): Promise<void> {
        try {
            await removeKey(PAGE_STORE, id);
        } catch {
            /* 同上 */
        }
    },
};
