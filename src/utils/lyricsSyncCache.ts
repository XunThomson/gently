/**
 * 歌词「同步参数」的按曲目缓存。
 *
 * 三个参数决定一次校正能不能对上：
 * 1. **偏移**（`utils/lyricsOffset.ts`，本文件不管它）——单独一份存储，因为它只与那份词有关；
 * 2. **手动挑的来路**——用户从歌词搜索里选了另一家的词（不同源同名歌曲差异很大）。
 *    以前这份选择只活在**本次播放**里：切歌再回来、或重启应用，源给的词又顶回来，用户得再挑一遍，
 *    于是「刚刚校准好的偏移」也就跟着失效了（偏移是对着那份词量的）。所以这里按曲目记住它，
 *    下次播放同一首时**先按缓存的来路取词**，取不到再退回源自动给的词；
 * 3. **上次搜的词**——再打开搜索面板时不用重敲（默认仍是「标题 + 歌手」）。
 *
 * 只存「来路」不存歌词正文：正文可能有几百 KB，而 `catalog.lyrics` 按引用重取一次足够快，
 * 也避免把第三方歌词落到本机缓存里长期驻留。
 *
 * 存储上限 200 首，超出时丢最旧的（与偏移那份存储的取舍一致）。
 */

const STORAGE_KEY = 'gently:lyrics-sync';
const MAX_ENTRIES = 200;

/** 手动挑的词从哪来：`source:trackId` 即核心的歌词引用 */
export interface AppliedLyricsChoice {
    /** 插件 id */
    source: string;
    /** 该插件内的曲目 id（用来拼 `source:trackId`） */
    trackId: string;
    /** 插件显示名（界面展示；插件卸载后仍能说清「这份词是从哪来的」） */
    sourceName: string;
    /** 那份词对应的曲目标题 / 歌手（各源同名歌曲不一致，界面要能区分） */
    title: string;
    artist: string;
}

export interface LyricsSyncEntry {
    applied?: AppliedLyricsChoice;
    query?: string;
}

/**
 * 插件内的**原始**曲目 id。
 *
 * 核心给的 `track.id` 已经是完整引用（`source:rawId`，见 `normalize_track`），
 * 而插件自己只认 rawId；两种形态都接受，统一剥掉 `source:` 前缀——引用就只能在这一处拼，
 * 否则很容易拼出 `wangyiyun:wangyiyun:123` 这种永远取不到词的引用（R68 实测踩过）。
 */
export function rawTrackIdOf(source: string, id: string): string {
    const prefix = `${source}:`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/** 缓存的歌词引用（`catalog.lyrics` 的 `ref`） */
export function appliedLyricsRef(choice: AppliedLyricsChoice): string {
    return `${choice.source}:${rawTrackIdOf(choice.source, choice.trackId)}`;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** localStorage 可能不存在（冒烟测试 / SSR）或被隐私模式禁用 */
function storage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

/** 读出来的东西一律当作不可信输入（本地存储可能被改、也可能是旧版本写的） */
function toChoice(value: unknown): AppliedLyricsChoice | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    if (
        !isNonEmptyString(raw.source) ||
        !isNonEmptyString(raw.trackId) ||
        !isNonEmptyString(raw.sourceName) ||
        !isNonEmptyString(raw.title)
    ) {
        return undefined;
    }
    return {
        source: raw.source,
        trackId: raw.trackId,
        sourceName: raw.sourceName,
        title: raw.title,
        artist: typeof raw.artist === 'string' ? raw.artist : '',
    };
}

function readAll(): Record<string, LyricsSyncEntry> {
    const store = storage();
    if (!store) return {};
    try {
        const raw = store.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        const out: Record<string, LyricsSyncEntry> = {};
        for (const [trackId, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!isNonEmptyString(trackId) || !value || typeof value !== 'object') continue;
            const entry = value as Record<string, unknown>;
            const applied = toChoice(entry.applied);
            const query = isNonEmptyString(entry.query) ? entry.query.trim() : undefined;
            if (applied || query) out[trackId] = {...(applied ? {applied} : {}), ...(query ? {query} : {})};
        }
        return out;
    } catch {
        return {};
    }
}

function writeAll(all: Record<string, LyricsSyncEntry>): void {
    const store = storage();
    if (!store) return;
    try {
        store.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
        /* 隐私模式 / 配额限制：缓存只是省一次挑选，写不进去不影响播放 */
    }
}

/** 写一条（键按写入顺序排列，超上限丢最旧的；未改动的字段原样保留） */
function writeEntry(trackId: string, mutate: (entry: LyricsSyncEntry) => LyricsSyncEntry | null): void {
    if (!isNonEmptyString(trackId)) return;
    const all = readAll();
    const existing = all[trackId] ?? {};
    delete all[trackId];
    const next = mutate(existing);
    if (next && (next.applied || next.query)) all[trackId] = next;

    const keys = Object.keys(all);
    while (keys.length > MAX_ENTRIES) {
        const oldest = keys.shift();
        if (oldest) delete all[oldest];
    }
    writeAll(all);
}

/** 读某首曲目的同步参数；没有就返回空对象 */
export function readLyricsSync(trackId: string): LyricsSyncEntry {
    return readAll()[trackId] ?? {};
}

/** 记住「这首曲目的词是从哪挑来的」 */
export function saveLyricsChoice(trackId: string, choice: AppliedLyricsChoice): void {
    writeEntry(trackId, (entry) => ({...entry, applied: choice}));
}

/** 记住上次搜索用的关键词（空串等于清掉） */
export function saveLyricsQuery(trackId: string, query: string): void {
    writeEntry(trackId, (entry) => {
        const trimmed = query.trim();
        return {...entry, ...(trimmed ? {query: trimmed} : {query: undefined})};
    });
}

/** 忘掉手动挑的词（回到「源给什么用什么」） */
export function clearLyricsChoice(trackId: string): void {
    writeEntry(trackId, (entry) => (entry.query ? {query: entry.query} : null));
}
