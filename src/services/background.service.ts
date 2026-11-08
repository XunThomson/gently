import {appConfig} from '../config/app.config';
import type {BackgroundAsset, WebAsset} from '../utils/backgroundSettings';

/**
 * 本地背景素材存储（IndexedDB）。
 *
 * 两个 object store 各管一类素材，这里只存"重"数据本身，元数据由上层
 * `BackgroundAsset` / `WebAsset` 持有：
 * - `videos`：用户导入的 mp4/webm Blob；
 * - `pages`：单文件网页壁纸的 HTML 文本。
 *
 * 设计约束：
 * - 不经过核心、不扩大文件系统权限，浏览器预览与桌面端走同一条路径；
 * - 所有写入入口先做类型/大小校验，失败以 `reason` 返回、**不抛异常**，
 *   便于 UI 直接映射成提示文案；
 * - 读取失败一律降级为 `null` / `false`，调用方退回默认背景即可，不需要 try/catch。
 *
 * 代价：清空 WebView 站点数据会丢背景；`reset` 时由 UI 调 `remove*` 清掉。
 * 「元数据还在但素材已丢」用 `has` / `hasWeb` 探测，设置页据此提示重新导入。
 *
 * @remarks
 * 记录 id 有两种来源：自动生成的随机 id，以及主题包显式传入的固定 id
 * （`skin:<id>`，见 `utils/skinPackage`）。后者依赖 IndexedDB `put` 的覆盖语义
 * 实现「一套皮肤一份背景，换素材即替换」。
 */

/** 数据库名。改名等同于丢弃老用户的全部背景素材，需配合迁移。 */
const DB_NAME = 'gently-backgrounds';

/** Schema 版本。`onupgradeneeded` 里按需补建缺失的 store，因此升版是幂等的。 */
const DB_VERSION = 2;

/** 视频 Blob 存储，记录形如 `{id, blob}`。 */
const VIDEO_STORE = 'videos';

/** 网页壁纸存储，记录形如 `{id, html}`。 */
const PAGE_STORE = 'pages';

/**
 * 保存失败原因，均为稳定的可翻译枚举值（UI 侧映射 i18n key）。
 *
 * - `unsupported`：当前环境没有 IndexedDB（SSR、部分隐私模式）；
 * - `empty`：文件大小为 0；
 * - `too-large`：超过 `appConfig.background.maxVideoBytes` / `maxWebBytes`；
 * - `unsupported-type`：MIME 与扩展名都不匹配；
 * - `storage`：IndexedDB 写入失败（配额不足、事务中止等）。
 */
export type BackgroundSaveError =
    | 'unsupported'
    | 'empty'
    | 'too-large'
    | 'unsupported-type'
    | 'storage';

/**
 * 视频保存结果。判别联合：`ok === true` 时可安全取 `asset`，
 * 否则用 `reason` 决定提示文案。
 */
export type BackgroundSaveResult =
    | {ok: true; asset: BackgroundAsset}
    | {ok: false; reason: BackgroundSaveError};

/** 网页壁纸保存结果，语义同 {@link BackgroundSaveResult}。 */
export type WebSaveResult =
    | {ok: true; web: WebAsset}
    | {ok: false; reason: BackgroundSaveError};

/** `videos` store 的记录结构；`id` 为 keyPath。 */
interface StoredVideo {
    id: string;
    blob: Blob;
}

/** `pages` store 的记录结构；`id` 为 keyPath。 */
interface StoredPage {
    id: string;
    html: string;
}

/** 视频扩展名兜底：某些系统的 `File.type` 为空，只能靠文件名判断。 */
const VIDEO_EXT = /\.(mp4|webm|m4v|ogv|ogg)$/i;

/** 网页扩展名兜底，作用同上。 */
const WEB_EXT = /\.(html?|xhtml)$/i;

/** 共享的数据库连接；首次 `openDb` 后复用，避免重复 open。 */
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * 打开（并缓存）IndexedDB 连接。
 *
 * @returns 已就绪的 `IDBDatabase`，同一会话内复用同一个 Promise。
 * @remarks
 * - 环境不支持 IndexedDB 时直接 reject，由各方法捕获后返回 `unsupported` / 降级值；
 * - `onupgradeneeded` 只在 store 缺失时创建，因此重复升级不会报错；
 * - 打开失败后会把缓存清空，让下一次调用可以重试，而不是永久持有一个 rejected Promise；
 * - 未注册 `onblocked`：多标签页同时升级版本时会一直 pending，属已知边界。
 */
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

/**
 * 生成素材 id。
 *
 * @returns 优先 `crypto.randomUUID()`；不可用时退化为
 * `bg-<时间戳36进制>-<随机串>`，仅需在本机内唯一。
 */
function newId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 判断文件是否为受支持的视频。
 *
 * @remarks MIME 与扩展名任一命中即可，兼容 `file.type` 为空的场景。
 */
function isVideo(file: File): boolean {
    return file.type.startsWith('video/') || VIDEO_EXT.test(file.name);
}

/**
 * 判断文件是否为受支持的网页壁纸。
 *
 * @remarks MIME 与扩展名任一命中即可；`application/xhtml+xml` 单独放行。
 */
function isWebPage(file: File): boolean {
    return file.type.startsWith('text/html') ||
        file.type === 'application/xhtml+xml' ||
        WEB_EXT.test(file.name);
}

/**
 * 写入（或按 `id` 覆盖）一条记录。
 *
 * @param store - 目标 object store 名，见 {@link VIDEO_STORE} / {@link PAGE_STORE}。
 * @param value - 带 `id` 字段的记录，`id` 由 keyPath 读取。
 * @throws IndexedDB 打开或写入失败时抛出，由调用方统一转成 `storage`。
 * @remarks 等待 `tx.oncomplete` 而非 `request.onsuccess`，确保事务真正提交。
 */
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

/**
 * 按 id 读取一条记录。
 *
 * @returns 命中时返回记录，未命中返回 `undefined`。
 * @throws IndexedDB 打开或读取失败时抛出，由调用方降级为 `null`。
 */
async function get<T>(store: string, id: string): Promise<T | undefined> {
    const db = await openDb();
    return await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const request = tx.objectStore(store).get(id);
        request.onsuccess = () => resolve(request.result as T | undefined);
        request.onerror = () => reject(request.error ?? new Error('indexedDB read failed'));
    });
}

/**
 * 探测 key 是否存在。
 *
 * @returns 存在为 `true`，不存在或读取失败为 `false`。
 * @remarks 用 `getKey` 而非 `get`，避免把整个 Blob / HTML 读进内存——
 * 典型用途只是「素材还在不在」。
 */
async function hasKey(store: string, id: string): Promise<boolean> {
    const db = await openDb();
    return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const request = tx.objectStore(store).getKey(id);
        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => reject(request.error ?? new Error('indexedDB read failed'));
    });
}

/**
 * 删除一个 key。
 *
 * @throws IndexedDB 打开或删除失败时抛出，由调用方吞掉。
 * @remarks 等待 `tx.oncomplete`，确保删除已提交。
 */
async function removeKey(store: string, id: string): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB delete failed'));
    });
}

/**
 * 本地背景素材读写服务。
 *
 * 全部方法都是「不抛异常」风格：写入用 `{ok, reason}` 表达失败，
 * 读取用 `null` / `false` 表达缺失，方便 UI 在任意时刻安全调用。
 */
export const backgroundService = {
    /**
     * 保存用户选择的视频。**先校验类型与大小**，再写 IndexedDB；
     * 任何失败都返回可翻译的原因，不抛异常。
     *
     * @param file - 用户选择的视频文件。
     * @param id - 可选固定 id。主题包用 `skin:<id>` 覆盖同一键；
     * 省略则自动生成随机 id。
     * @returns 成功时带 `asset` 元数据（`id` / `name` / `size` / `type` / `importedAt`），
     * 失败时带 `reason`。
     * @remarks
     * 存的是原始 `File`（本身即 `Blob`），不转 base64，避免体积膨胀；
     * 若通过扩展名识别，`file.type` 可能为空字符串，此时 `asset.type` 也为空。
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
     * 保存单文件网页壁纸。
     *
     * 只接受 HTML 文本；外部 CSS/JS/图片不会自动带入，需要用户自己内联
     * （渲染端还会再加沙箱与 CSP）。
     *
     * @param file - 用户选择的 `.html` / `.xhtml` 文件。
     * @param id - 可选固定 id，覆盖语义同 {@link backgroundService.save}。
     * @returns 成功时带 `web` 元数据（`id` / `name` / `size`）。
     * @remarks
     * 写入前会把整个文件读成字符串，体积上限由 `appConfig.background.maxWebBytes` 约束，
     * 避免一次把超大文件读进内存。
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

    /**
     * 读取视频 Blob。
     *
     * @param id - 素材 id。
     * @returns Blob；不存在、类型不对或读取出错时返回 `null`（调用方退回默认背景）。
     * @remarks 返回的是 Blob 而非 ObjectURL，调用方负责
     * `URL.createObjectURL()` 并在用完后 `revokeObjectURL()`，避免内存泄漏。
     */
    async load(id: string): Promise<Blob | null> {
        try {
            const value = await get<StoredVideo>(VIDEO_STORE, id);
            return value?.blob instanceof Blob ? value.blob : null;
        } catch {
            return null;
        }
    },

    /**
     * 读取网页壁纸的 HTML 文本。
     *
     * @param id - 素材 id。
     * @returns HTML 字符串；不存在或读取出错时返回 `null`。
     */
    async loadWeb(id: string): Promise<string | null> {
        try {
            const value = await get<StoredPage>(PAGE_STORE, id);
            return typeof value?.html === 'string' ? value.html : null;
        } catch {
            return null;
        }
    },

    /**
     * 探测视频素材是否还在。
     *
     * @param id - 素材 id。
     * @returns 存在为 `true`；不存在或探测失败为 `false`。
     * @remarks 用于「元数据还在但素材丢了」的场景（例如清过站点数据），
     * 设置页据此提示重新导入，比直接 `load` 更省内存。
     */
    async has(id: string): Promise<boolean> {
        try {
            return await hasKey(VIDEO_STORE, id);
        } catch {
            return false;
        }
    },

    /**
     * 探测网页壁纸是否还在，语义同 {@link backgroundService.has}。
     *
     * @param id - 素材 id。
     */
    async hasWeb(id: string): Promise<boolean> {
        try {
            return await hasKey(PAGE_STORE, id);
        } catch {
            return false;
        }
    },

    /**
     * 删除视频素材。
     *
     * @param id - 素材 id。
     * @remarks 不抛异常：清不掉只影响磁盘占用，不阻塞用户恢复默认背景。
     * 由 `reset` 流程在切换到默认背景后调用。
     */
    async remove(id: string): Promise<void> {
        try {
            await removeKey(VIDEO_STORE, id);
        } catch {
            /* 清不掉只影响磁盘占用，不阻塞用户恢复默认 */
        }
    },

    /**
     * 删除网页壁纸素材。
     *
     * @param id - 素材 id。
     * @remarks 不抛异常，理由同 {@link backgroundService.remove}。
     */
    async removeWeb(id: string): Promise<void> {
        try {
            await removeKey(PAGE_STORE, id);
        } catch {
            /* 同上 */
        }
    },
};