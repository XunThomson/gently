/**
 * 冒烟测试：不依赖浏览器，验证「状态层逻辑」与「各组件可渲染」。
 *
 * 运行方式见 AGENTS.md：esbuild 打包到临时目录后由 node 执行。
 * 退出码非 0 表示有断言或渲染失败。
 */
import {renderToString} from 'react-dom/server';
import {MemoryRouter} from 'react-router';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import type {ReactNode} from 'react';

import '../src/i18n';
import {ThemeProvider} from '../src/theme';
import {resolveTheme, themePresets} from '../src/theme';
import {activeUserSkinId, resolveActivePreset} from '../src/theme';
import {DEFAULT_PRESET_ID} from '../src/theme';
import {store, useActions} from '../src/store';
import {buildCssVars, themeConfig} from '../src/theme/tokens';
import {demoSourcesEnabled, demoSourcesReady, getActiveMusicSource, listMusicSources} from '../src/plugins';
import {catalogService, fileService, libraryService, recommendService, skinService} from '../src/services';
import zh from '../src/i18n/locales/zh.json';
import en from '../src/i18n/locales/en.json';
import {CORE_ERROR_CODES} from '../src/api';
import {CORE_EVENTS, EVENT_NAME_PATTERN} from '../src/services/core.events';
import {filterGroupsBySource, groupTracks} from '../src/utils/track';
import {toLyricLines} from '../src/utils/lyrics';
import {coverStyle, trackCoverStyle} from '../src/utils/cover';
import {canDownload} from '../src/hooks/useTrackActions';
import {pickQuality} from '../src/utils/quality';
import {getThemeSkin, parseSkin, resolveTheme as resolveSkin, serializeSkin} from '../src/theme';
import type {ThemeSkin} from '../src/theme';

import {TitleBar} from '../src/components/shell/title-bar';
import {Sidebar} from '../src/components/shell/sidebar';
import {PlayerBar} from '../src/components/shell/player-bar';
import {QueuePanel} from '../src/components/shell/player-bar/QueuePanel';
import {ActionsPanel} from '../src/components/shell/player-bar/ActionsPanel';
import {SourcePicker} from '../src/components/shell/player-bar/SourcePicker';
import {QualityPicker} from '../src/components/shell/player-bar/QualityPicker';
import {ConfirmDialog} from '../src/components/ui/dialog';
import {AlbumGrid} from '../src/components/ui/album-grid';
import {PlaylistGrid} from '../src/components/ui/playlist-grid';
import {ReasonChip} from '../src/components/ui/reason-chip';
import {buildMenuRoutes, appRoutes} from '../src/router/meta';

import RankingView from '../src/views/ranking';
import HotView from '../src/views/hot';
import DownloadView from '../src/views/download';
import DownloadingView from '../src/views/download/downloading';
import DownloadedView from '../src/views/download/downloaded';
import LocalView from '../src/views/local';
import {ScanPanel} from '../src/views/local/components/ScanPanel';
import PluginView from '../src/views/plugin';
import {PluginSettings} from '../src/views/plugin/components/plugin-settings';
import RecentView from '../src/views/recent';
import SettingView from '../src/views/setting';
import ThemeView from '../src/views/theme';
import FavoritesView from '../src/views/favorites';
import PlaylistView from '../src/views/playlist';
import CollectionView from '../src/views/collection';
import NowPlayingView from '../src/views/now-playing';
import SearchView from '../src/views/search';
import {
    coreAlbum,
    coreAvailable,
    coreCreateDownload,
    coreListenDownloads,
    corePauseDownload,
    coreLoadFavorites,
    coreLoadLocal,
    coreLoadPlaylists,
    coreLoadRecent,
    coreLyrics,
    corePlaybackReport,
    coreResolveUrl,
    coreRecommendHome,
    coreSavePlaylist,
    coreSearch,
    coreSetFavorite,
    coreTopList,
    coreTopLists,
    coreTrackDetail,
    invokeCore,
} from '../src/services';

const failures: string[] = [];
const notes: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
    if (condition) {
        notes.push(`  ok   ${name}`);
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
        notes.push(`  FAIL ${name}`);
    }
}

/* ---------------- 假宿主（把桌面端才走得到的分支也测掉） ---------------- */

const envelope = (data: unknown) => ({ok: true, data, traceId: 'fake'});
const failure = (code: string, message: string) => ({
    ok: false,
    error: {code, message},
    traceId: 'fake',
});

/**
 * 假宿主暴露给测试的句柄。
 *
 * `emit()` 走的是 Tauri 真实的事件投递路径：`plugin:event|listen` 登记回调 →
 * 后端 `window.__TAURI_INTERNALS__.runCallback(handlerId, eventData)` →
 * 我们的 `listenCore` 收到 `{event, id, payload}`。因此这里能测到**事件链路**，
 * 而不只是命令：下载进度、扫描进度、流式搜索的 partial/done 都在射程内。
 */
export interface FakeCoreHost {
    /** 从「后端」推一条事件给已订阅的处理器 */
    emit: (event: string, payload: unknown) => void;
    /** 前端订阅过的事件名（**历史**，用于断言事件名合法、且确实是契约里那些） */
    subscribedEvents: string[];
    /** **当前仍生效**的订阅（退订会移除）——等订阅要用它，不能用历史（否则上一轮的订阅会让等待假通过） */
    activeEvents: () => string[];
    /** 事件名不合法（Tauri 会拒绝）时记在这里——出现即失败 */
    invalidEvents: string[];
}

/**
 * 临时把 `window.__TAURI_INTERNALS__` 换成假实现，用完恢复现场。
 *
 * 冒烟跑在 Node（没有 Tauri），`coreAvailable()` 恒为 false，于是「核心优先读」
 * 「核心报错如实呈现」这些分支永远没被执行过。这里替换 `invoke` 与回调注册
 * （`transformCallback` / `runCallback`，语义照抄 tauri 的 `scripts/core.js`）——
 * `@tauri-apps/api` 正是转调它们，因此测的是我们自己的桥接与服务层，而不是另写一套假门面。
 *
 * `plugin:event|listen` 会照 Tauri 的规则校验事件名（只允许字母数字与 `- / : _`）：
 * 名字不合法就抛错并记进 `invalidEvents`——R27 那个「点号事件名让所有事件静默丢失」
 * 的 bug，在这里会立刻变成一条 FAIL。
 */
async function withFakeCore<T>(
    handler: (command: string, params: Record<string, unknown>, host: FakeCoreHost) => unknown,
    body: (host: FakeCoreHost) => Promise<T>,
): Promise<T> {
    const scope = globalThis as unknown as Record<string, unknown>;
    const original = scope.window;

    const callbacks = new Map<number, (data: unknown) => unknown>();
    const listeners = new Map<number, {event: string; handlerId: number}>();
    let nextId = 1;

    const host: FakeCoreHost = {
        subscribedEvents: [],
        invalidEvents: [],
        activeEvents: () => [...new Set([...listeners.values()].map((entry) => entry.event))],
        emit: (event, payload) => {
            for (const [eventId, listener] of listeners) {
                if (listener.event !== event) continue;
                callbacks.get(listener.handlerId)?.({event, id: eventId, payload});
            }
        },
    };

    scope.window = {
        ...(original as object | undefined),
        /* Node 里没有 window：桌面端代码用到的 window.* 要补上（timer 是最常用的一对） */
        setTimeout: (handler: () => void, timeout?: number) => globalThis.setTimeout(handler, timeout),
        clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
        /* `@tauri-apps/api/event` 的 unlisten 会顺手叫一下这个内部对象（真实宿主里由
           tauri 的初始化脚本注入），假宿主给个空实现即可——订阅登记我们自己管 */
        __TAURI_EVENT_PLUGIN_INTERNALS__: {unregisterListener: () => undefined},
        __TAURI_INTERNALS__: {
            invoke: (command: string, args?: {command?: string; params?: Record<string, unknown>}) => {
                /* 两种调用形态：我们的 `core_invoke`（命令名在 args.command 里）
                   与 Tauri 自带插件（`@tauri-apps/api/event` 直接 invoke('plugin:event|listen', {...})，
                   参数就是 args 本身）。 */
                const wrapped = args?.command !== undefined;
                const name = String(wrapped ? args?.command : command);
                const params = ((wrapped ? args?.params : args) ?? {}) as Record<string, unknown>;

                /* Tauri 的事件通道（`@tauri-apps/api/event` 直接用这些名字） */
                if (name === 'plugin:event|listen') {
                    const event = String((params as {event?: unknown}).event ?? '');
                    const handlerId = Number((params as {handler?: unknown}).handler);
                    if (!EVENT_NAME_PATTERN.test(event)) {
                        host.invalidEvents.push(event);
                        throw new Error(`only alphanumeric, '-', '/', ':', '_' permitted for event names: ${event}`);
                    }
                    const eventId = nextId++;
                    listeners.set(eventId, {event, handlerId});
                    host.subscribedEvents.push(event);
                    return Promise.resolve(eventId);
                }
                if (name === 'plugin:event|unlisten') {
                    const eventId = Number((params as {eventId?: unknown}).eventId);
                    listeners.delete(eventId);
                    return Promise.resolve(null);
                }
                if (name === 'plugin:event|emit') return Promise.resolve(null);

                return Promise.resolve(handler(name, params, host));
            },
            transformCallback: (callback: (data: unknown) => unknown, once = false) => {
                const identifier = nextId++;
                callbacks.set(identifier, (data) => {
                    if (once) callbacks.delete(identifier);
                    return callback(data);
                });
                return identifier;
            },
            unregisterCallback: (identifier: number) => callbacks.delete(identifier),
            runCallback: (identifier: number, data: unknown) => callbacks.get(identifier)?.(data),
        },
    };

    try {
        return await body(host);
    } finally {
        if (original === undefined) delete scope.window;
        else scope.window = original;
    }
}

/** 流式搜索用例的固定关键词与 searchId（假宿主 `catalog.search` 与测试推事件时共用） */
const STREAM_SEARCH_KEYWORD = '假宿主流式搜索';
/** 竞态用例：事件在 `catalog.search` 返回**之前**就到达（本地插件几乎瞬时） */
const STREAM_RACE_KEYWORD = '假宿主竞态搜索';
const STREAM_SEARCH_ID = 'search-fake-1';

/**
 * 等挂起的 IPC 落地。
 *
 * `invokeCore` 里有 `await import('@tauri-apps/api/core')`，因此**假宿主收到命令总比调用晚一拍**：
 * 断言「有没有发这条命令」之前必须先 flush，否则会把上一拍的调用算到这一拍头上
 * （R29 的暂停用例就栽在这里）。
 */
const flushIpc = () => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * 等前端把事件订阅登记到假宿主上。
 *
 * `coreSearch` / `scan` 是「先建任务、再异步订阅事件」的：事件推得太早会丢
 * （真实宿主同理，只是窗口极小）。测试里等订阅确实登记了再推，才不是靠运气。
 */
async function waitForSubscription(host: FakeCoreHost, event: string, timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (host.activeEvents().includes(event)) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return false;
}

function render(name: string, node: ReactNode, initialPath?: string): void {
    try {
        const html = renderToString(
            <MemoryRouter initialEntries={initialPath ? [initialPath] : undefined}>
                <ThemeProvider>{node}</ThemeProvider>
            </MemoryRouter>,
        );
        check(`render ${name}`, html.length > 0, 'empty html');
    } catch (err) {
        failures.push(`render ${name} — ${(err as Error).message}`);
        notes.push(`  FAIL render ${name}`);
    }
}

/* ---------------- i18n 死键检查 ---------------- */

/** 这些前缀下的键由模板字符串拼接而成，无法按字面量检索 */
const DYNAMIC_PREFIXES = [
    'page.download.status.',
    'page.setting.theme',
    'language.',
    // utils/quality.ts 的 qualityLabelKey() 按档位拼接
    'quality.',
    // src/i18n/errors.ts 的 errorKey()：错误码的点号换成下划线后拼接
    'errors.',
];

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
    return Object.entries(obj).flatMap(([key, value]) => {
        const full = prefix ? `${prefix}.${key}` : key;
        return value && typeof value === 'object'
            ? flattenKeys(value as Record<string, unknown>, full)
            : [full];
    });
}

/** 读取 src 下所有源码文本，用于检索 i18n key 是否被引用 */
function readSourceText(dir = 'src', acc: string[] = []): string {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) readSourceText(full, acc);
        else if (/\.(tsx?|json)$/.test(entry.name)) acc.push(readFileSync(full, 'utf8'));
    }
    return acc.join('\n');
}

function checkI18n(): void {
    const source = readSourceText();
    const zhKeys = flattenKeys(zh as Record<string, unknown>);
    const enKeys = flattenKeys(en as Record<string, unknown>);

    const missing = zhKeys.filter((key) => !enKeys.includes(key));
    check('i18n: zh/en 键集合一致', missing.length === 0, `en 缺少 ${missing.join(', ')}`);

    const dead = zhKeys.filter(
        (key) =>
            !DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
            !source.includes(`'${key}'`) &&
            !source.includes(`"${key}"`),
    );
    check('i18n: 无未被引用的死键', dead.length === 0, `死键 ${dead.join(', ')}`);

    /* 错误码 → 文案必须**全覆盖**：新增错误码却忘了翻译，界面就会退回开发者说明。
       这里直接拿运行时可用的 CORE_ERROR_CODES 与两份 locale 对账（点号换下划线）。 */
    const untranslated = Object.values(CORE_ERROR_CODES).filter((code) => {
        const key = `errors.${code.replace(/\./g, '_')}`;
        return !zhKeys.includes(key) || !enKeys.includes(key);
    });
    check(
        'i18n: 每个错误码都有 zh/en 文案',
        untranslated.length === 0,
        `缺翻译 ${untranslated.join(', ')}`,
    );
}

/* ---------------- CSS token 检查 ---------------- */

/** 收集 src 下所有 CSS 文件内容 */
function readCssText(dir = 'src', acc: string[] = []): string {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) readCssText(full, acc);
        else if (entry.name.endsWith('.css')) acc.push(readFileSync(full, 'utf8'));
    }
    return acc.join('\n');
}

/**
 * 所有 `var(--token)` 引用的 token 都必须有定义：
 * 定义来源 = 主题注入的 CSS 变量 ∪ 任何 CSS 里 `--x:` 的本地定义 ∪ 内联样式注入的局部变量白名单。
 */
const INLINE_STYLE_VARS = ['--grid-template'];

function checkCssTokens(): void {
    const css = readCssText();

    const defined = new Set<string>([
        ...Object.keys(buildCssVars(themeConfig, 'light')),
        ...Object.keys(buildCssVars(themeConfig, 'dark')),
        ...INLINE_STYLE_VARS,
    ]);
    for (const match of css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(match[1]);

    const used = new Set<string>();
    for (const match of css.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) used.add(match[1]);

    const missing = [...used].filter((name) => !defined.has(name));
    check('css: 引用的 token 全部有定义', missing.length === 0, `未定义 ${missing.join(', ')}`);
}

async function main(): Promise<void> {
    /* 演示源（`mock` / `bilibili` / `netease`）**只在没有 Tauri 宿主时注册**，而且是
       动态 `import()`（这样桌面端产物里不会留下 mock 数据）。冒烟的运行环境没有宿主，
       因此这里必须等注册完成再断言——打包器把动态 import 编译成异步 require，
       注册落在下一个微任务里，不等就会看到「一个源都没有」的假象。 */
    await demoSourcesReady;
    check('plugins: 无宿主时才注册演示源', demoSourcesEnabled && listMusicSources().length > 0);

    /* ---------------- i18n ---------------- */
    checkI18n();

    /* ---------------- CSS token ---------------- */
    checkCssTokens();

    /* ---------------- 主题 ---------------- */
    const light = buildCssVars(themeConfig, 'light');    const dark = buildCssVars(themeConfig, 'dark');

    check('theme: light/dark 变量数量一致', Object.keys(light).length === Object.keys(dark).length);
    check('theme: 浅色应用底色较亮', light['--bg-app'] !== dark['--bg-app']);
    check('theme: 未解析的语义引用已全部展开', !Object.values(light).some((v) => v.startsWith('{')), 'still has {ref}');
    check('theme: 搜索框高度由配置驱动', light['--search-box-height'] === `${themeConfig.components.searchBox.height}px`);
    check('theme: 间距 token 已生成', light['--space-4'] === '16px');

    /* ---------------- 主题市场预设 ---------------- */
    check('theme: 主题市场至少提供 2 套预设', themePresets.length >= 2);
    check('theme: 每套预设都有预览色块', themePresets.every((p) => p.swatches.length >= 3));
    /* 内置预设必须带 `builtin` 标记：视图据此隐藏「删除皮肤」（核心不认识内置 id，
       点了只会 `skin.not_found`，而界面还会谎报「已删除」——R51 实测过）。 */
    check('theme: 内置预设都标了 builtin（视图据此隐藏删除入口）', themePresets.every((p) => p.builtin === true));

    const ocean = resolveTheme(themeConfig, 'ocean');
    check('theme: 预设覆盖品牌色', ocean.palette.brand !== themeConfig.palette.brand);
    check('theme: 预设可覆盖配色板', ocean.scheme.light.app !== themeConfig.scheme.light.app);
    check(
        'theme: 未声明的字段继承主题配置',
        ocean.components.dataTable.cellPaddingY === themeConfig.components.dataTable.cellPaddingY,
    );
    check('theme: 未知预设回落默认主题', resolveTheme(themeConfig, 'nope').palette.brand === themeConfig.palette.brand);

    const presetVars = buildCssVars(ocean, 'light');
    check('theme: 预设会改变注入的 --brand', presetVars['--brand'] === ocean.palette.brand);

    /* 密度类预设：可以覆盖组件度量（行高 / 间距 / 侧边栏宽度） */
    const compact = resolveTheme(themeConfig, 'compact');
    const cozy = resolveTheme(themeConfig, 'cozy');
    check(
        'theme: 紧凑预设压缩表格行高',
        compact.components.dataTable.rowMinHeight < themeConfig.components.dataTable.rowMinHeight,
    );
    check(
        'theme: 紧凑预设压缩外壳高度',
        compact.components.titleBar.height < themeConfig.components.titleBar.height &&
            compact.components.playerBar.height < themeConfig.components.playerBar.height,
    );
    check(
        'theme: 宽适预设放宽侧边栏与留白',
        cozy.components.sidebar.width > themeConfig.components.sidebar.width &&
            cozy.components.view.paddingY > themeConfig.components.view.paddingY,
    );
    check(
        'theme: 密度预设未声明的字段仍继承',
        compact.components.titleBar.logoFontSize === themeConfig.components.titleBar.logoFontSize &&
            compact.palette.success === themeConfig.palette.success,
    );
    check(
        'theme: 密度预设同样注入 CSS 变量',
        buildCssVars(compact, 'light')['--table-row-min-height'] ===
            `${compact.components.dataTable.rowMinHeight}px`,
    );

    /* ---------------- 插件（数据源） ---------------- */
    const sources = listMusicSources();
    check('plugins: 内置源已注册', sources.length > 0);
    check('plugins: 当前源可用', !!getActiveMusicSource().info.id);

    /* 榜单/分类：结构由源决定（分类树 + 一页内容 + 分页标记）
       浏览器里没有核心，因此两条路径都必须**没有错误**（有错误说明门面把 mock 兜底弄丢了） */
    const tree = await catalogService.fetchTopLists();
    check('plugins: fetchTopLists 返回分类树', tree.groups.length > 0 && tree.groups[0].items.length > 0);
    check('plugins: 浏览器下分类树不带错误', tree.error === undefined);

    const firstItem = tree.groups[0].items[0];
    const firstPage = await catalogService.fetchTopList(catalogService.defaultSourceId(), firstItem.id);
    const page1 = firstPage.page;
    check('plugins: fetchTopList 返回一页曲目', page1.items.length > 0 && firstPage.error === undefined);
    check('plugins: 分页标记与页号自洽', page1.hasMore === !!page1.nextPage && page1.nextPage === 2);

    const page2 = (await catalogService.fetchTopList(catalogService.defaultSourceId(), firstItem.id, 2)).page;
    check(
        'plugins: 第二页与第一页不重复',
        page2.items.length > 0 && page2.items.every((t) => !page1.items.some((p) => p.id === t.id)),
    );
    check(
        'plugins: 同一 (源, 分类, 页) 结果稳定',
        (await catalogService.fetchTopList(catalogService.defaultSourceId(), firstItem.id)).page.items[0]?.id ===
            page1.items[0].id,
    );

    const found = await catalogService.searchIn('晚风');
    check('plugins: search 命中曲目', found.length > 0 && found[0].title.includes('晚风'));
    check('plugins: 空关键词返回空', (await catalogService.searchIn('   ')).length === 0);

    /* 详情页数据（浏览器预览走 mock，与核心返回同形：对象 + tracks） */
    const mockAlbum = await catalogService.fetchAlbum('mock', 'album:林清野');
    check(
        'plugins: fetchAlbum 返回专辑与曲目',
        !!mockAlbum && mockAlbum.title.length > 0 && mockAlbum.tracks.length > 0,
    );
    check('plugins: 不存在的专辑返回 null', (await catalogService.fetchAlbum('mock', 'album:nope')) === null);

    const mockCurated = await catalogService.fetchCuratedPlaylist('mock', 'curated:midnight');
    check(
        'plugins: fetchCuratedPlaylist 返回歌单与曲目',
        !!mockCurated && mockCurated.description.length > 0 && mockCurated.tracks.length > 0,
    );

    /* 封面：图片地址 / 渐变 / 空值三条路径 */
    check(
        'cover: 图片地址用 background-image',
        String(coverStyle('https://example.com/a.jpg', 'x').backgroundImage).includes('url('),
    );
    check('cover: 渐变原样透传', coverStyle('linear-gradient(#000,#fff)', 'x').background === 'linear-gradient(#000,#fff)');
    check(
        'cover: 空封面按标题哈希兜底（不留透明块）',
        typeof coverStyle('', 'x').background === 'string' &&
            String(coverStyle('', 'x').background).startsWith('linear-gradient'),
    );
    check('cover: 同一标题兜底稳定', coverStyle('', 'x').background === coverStyle('', 'x').background);
    /* 曲目封面：插件给的图优先，没有才用渐变占位（6 处渲染共用这一个优先级） */
    check(
        'cover: 曲目有封面图时优先用图',
        String(
            trackCoverStyle({
                artwork: 'https://example.com/cover.jpg',
                gradient: 'linear-gradient(#000,#fff)',
                title: 't',
                artist: 'a',
            }).backgroundImage,
        ).includes('url('),
    );
    check(
        'cover: 没有封面图时用渐变占位',
        trackCoverStyle({gradient: 'linear-gradient(#000,#fff)', title: 't', artist: 'a'}).background ===
            'linear-gradient(#000,#fff)',
    );
    check(
        'cover: 两者都没有时按标题哈希兜底',
        String(trackCoverStyle({title: 't', artist: 'a'}).background).startsWith('linear-gradient'),
    );

    /* ---------------- 皮肤「当前用哪套」的唯一裁决 ----------------
       桌面端核心只知道**用户皮肤**的激活状态（内置预设不在它的库里），本地只知道 id
       （内置预设也只能这样记）——两者冲突时必须有一套明确裁决，否则会出现
       「核心说 A、界面显示 B」。 */
    const importedSkin: ThemeSkin = {
        id: 'smoke-user-skin',
        name: '冒烟用户皮肤',
        description: '',
        author: 'test',
        swatches: ['#000000'],
        palette: {brand: '#000000'},
    };
    check(
        'skin: 核心标了 active 就以核心为准（本地记的 id 不作数）',
        resolveActivePreset('smoke-user-skin', 'compact', [importedSkin]) === 'smoke-user-skin',
    );
    check(
        'skin: 核心没标 active 时沿用本地选择（内置预设）',
        resolveActivePreset(null, 'compact', [importedSkin]) === 'compact',
    );
    check(
        'skin: 本地 id 已失效（皮肤被删）时回到默认预设',
        resolveActivePreset(null, 'smoke-user-skin', []) === DEFAULT_PRESET_ID,
    );
    check(
        'skin: 从 skin.list 读出激活的用户皮肤',
        activeUserSkinId([
            {...importedSkin, active: false},
            {...importedSkin, id: 'other', active: true},
        ]) === 'other' && activeUserSkinId([importedSkin]) === null,
    );

    /* ---------------- 多音源聚合 / 音质 / 回退 ---------------- */
    const activeSources = catalogService.listActiveSources();
    check('source: 至少注册 3 个可用音源', activeSources.length >= 3);

    const recommend = await catalogService.fetchRecommendAll(12);
    check('source: 聚合推荐有结果', recommend.length > 0);
    check(
        'source: 聚合结果带音源候选',
        recommend.every((group) => group.candidates.length === group.sourceCount && group.sourceCount >= 1),
    );

    const sample = recommend[0];
    const twin = {...sample, id: 'twin', source: 'bilibili'};
    const merged = groupTracks([{...sample, id: 'origin'}, twin], () => ['high', 'standard']);
    check('source: 同一首歌跨源合并为一条', merged.length === 1);
    check('source: 合并后保留两个候选', merged[0].sourceCount === 2);
    check('source: 聚合条目 id 稳定可复现', merged[0].id.startsWith('song:'));

    check(
        'source: 按音源筛选收敛候选',
        filterGroupsBySource(merged, 'bilibili')[0]?.candidates.length === 1,
    );
    check('source: 筛选到没有该音源的源则整条隐藏', filterGroupsBySource(merged, 'ghost').length === 0);

    catalogService.setSourceEnabled('netease', false);
    check(
        'source: 停用后不再参与聚合',
        !catalogService.listActiveSources().some((source) => source.id === 'netease'),
    );
    catalogService.setSourceEnabled('netease', true);

    check('quality: 期望档位超出源能力时降级', pickQuality(['high', 'standard'], 'hires') === 'high');
    check('quality: 期望档位可用时取该档', pickQuality(['hires', 'lossless', 'high'], 'high') === 'high');
    check('quality: 源不支持任何档位返回 null', pickQuality([], 'high') === null);

    const baseTrack = (await catalogService.fetchRecommendFrom(3))[0];
    check(
        'quality: 解析结果带上实际音源与音质',
        (await catalogService.resolveUrl(baseTrack, 'high', 'mock'))?.source === 'mock',
    );
    check(
        'source: 未注册音源解析返回 null',
        (await catalogService.resolveUrl(baseTrack, 'high', 'ghost')) === null,
    );

    /* ---------------- 本地数据门面 ---------------- */
    const local = await libraryService.loadLocal();
    const downloads = await libraryService.loadDownloads();
    const plugins = await libraryService.loadPlugins();
    check('services: 本地曲库非空', local.length > 0);
    check('services: 下载任务非空', downloads.length > 0);
    check('services: 插件列表非空', plugins.some((p) => p.builtin));

    /* 浏览器（非 Tauri）环境下文件操作必须是安全的空操作 */
    let fileOk = true;
    try {
        await fileService.revealInDir('D:/Music/demo.flac');
    } catch {
        fileOk = false;
    }
    check('services: 非 Tauri 环境下文件操作为空操作', fileOk);

    /* ---------------- 状态层 ---------------- */
    const actions = useActions();
    const s = () => store.getState();

    check('store: 初始未在播放', s().player.current === null && !s().player.playing);

    await actions.library.load();
    check('store: library.load 写入数据', s().library.loaded && s().library.local.length > 0);
    check('store: 重复 load 幂等', s().library.local.length === local.length);

    const first = s().library.local[0];
    actions.player.play(first, s().library.local);
    check('store: play 设置当前曲目', s().player.current?.id === first.id && s().player.playing);
    check('store: play 记录播放时长', s().player.duration === first.durationSec);
    check('store: play 写入最近播放', s().library.recent.some((r) => r.id === first.id));

    actions.library.clearRecent();
    check('store: 清空最近播放', s().library.recent.length === 0);
    actions.player.play(first, s().library.local);

    actions.player.tick();
    check('store: tick 推进进度', s().player.elapsed === 1);

    actions.player.next();
    check('store: next 切到队首（顺序播放且 index=0 越界时停止）', s().player.playing === false || s().player.current?.id !== first.id);

    const queue = s().library.local.slice(0, 3);
    actions.player.play(queue[0], queue);
    actions.player.next();
    check('store: next 前进到下一首', s().player.current?.id === queue[1].id);
    actions.player.prev();
    check('store: prev 回到开头', s().player.elapsed === 0);

    actions.player.setRepeat('one');
    const before = s().player.current?.id;
    actions.player.next();
    check('store: 单曲循环保持同一首', s().player.current?.id === before);
    actions.player.setRepeat('off');

    actions.player.setVolume(2);
    check('store: 音量上限钳制', s().player.volume === 1);

    actions.player.toggle();
    check('store: toggle 暂停', s().player.playing === false);

    /* 列表点击语义：当前曲目 = 播放/暂停，其他曲目 = 切歌 */
    actions.player.play(queue[0], queue);
    check('store: 播放队列首曲目', s().player.current?.id === queue[0].id && s().player.playing);
    actions.player.playOrToggle(queue[0], queue);
    check('store: 点当前曲目切换为暂停', !s().player.playing && s().player.current?.id === queue[0].id);
    actions.player.playOrToggle(queue[0], queue);
    check('store: 再点当前曲目恢复播放', s().player.playing);
    actions.player.playOrToggle(queue[2], queue);
    check('store: 点其他曲目切歌播放', s().player.current?.id === queue[2].id && s().player.playing);

    /* 歌词：随播放异步加载，切歌后不串词 */
    await new Promise((resolve) => setTimeout(resolve, 220));
    check('store: 播放后异步加载歌词', s().player.lyrics.length > 0);
    check(
        'store: 歌词时间轴严格递增',
        s().player.lyrics.every((line, i, all) => i === 0 || line.time > all[i - 1].time),
    );
    actions.player.stop();
    check('store: stop 清空歌词与进度', s().player.lyrics.length === 0 && s().player.elapsed === 0);

    /* 歌词解析：核心只交付原文，行数组由前端解析（只有这一份解析器） */
    const lrcLines = toLyricLines({
        format: 'lrc',
        content: '[ti:示例]\n[00:01.50]第一句\n[00:03]第二句\n[00:03]同一时刻的第二行',
        translated: '[00:01.50]first\n[00:03]second',
    });
    check('lyrics: LRC 解析出时间轴并按时间排序', lrcLines.length === 2 && lrcLines[0].time === 1.5);
    check(
        'lyrics: 同一时间戳的多行合并、译文按时间戳对齐',
        lrcLines[1].text.includes('第二句') &&
            lrcLines[1].text.includes('同一时刻的第二行') &&
            lrcLines[0].translation === 'first',
    );
    check(
        'lyrics: 纯文本按行给占位时序（源没给时间轴时也能高亮）',
        toLyricLines({format: 'plain', content: '甲\n乙\n丙'}).map((line) => line.text).join(',') === '甲,乙,丙',
    );
    check(
        'lyrics: 核心已解析好的行直接透传',
        toLyricLines({format: 'lrc', content: '[00:09]忽略', lines: [{time: 5, text: '来自核心'}]})[0].text ===
            '来自核心',
    );
    check(
        'lyrics: 一个时间标签都没有时退回纯文本（不显示空歌词）',
        toLyricLines({format: 'lrc', content: '假格式\n没有时间轴'}).length === 2,
    );

    /* 音源链路：数据源解析地址 → store 标记可播放 → 音频引擎回写进度 */
    const resolvedUrl = await catalogService.resolveUrl(baseTrack, 'high', 'mock');
    check('plugins: 示例源提供可播放地址（内置测试音频）', !!resolvedUrl?.url);

    actions.player.play(baseTrack, [baseTrack]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    check('store: 播放后标记可播放并写入音频地址', s().player.playable && !!s().player.audioUrl);

    actions.player.setProgress(42, 200);
    check(
        'store: 音频引擎回写进度与时长',
        s().player.elapsed === 42 && s().player.duration === 200,
    );

    actions.player.markUnplayable();
    check(
        'store: 音源不可用时退回模拟时钟',
        !s().player.playable && s().player.audioUrl === null,
    );

    actions.player.seek(10);
    check('store: seek 同步更新进度', s().player.elapsed === 10);

    /* ---------------- 音源回退（播放器行为） ---------------- */
    /* 首个候选不可用（未注册源）时应自动切到下一个可用源 */
    const ghostTrack = {...baseTrack, id: 'ghost:1', source: 'ghost'};
    const groupedWithGhost = {
        ...baseTrack,
        id: 'song:fallback-probe',
        candidates: [
            {source: 'ghost', track: ghostTrack, qualities: ['standard' as const]},
            {source: 'mock', track: baseTrack, qualities: ['high' as const, 'standard' as const]},
        ],
        sourceCount: 2,
    };
    actions.player.play(groupedWithGhost, [groupedWithGhost]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    check(
        'source: 首个候选不可用时自动回退到可用音源',
        s().player.activeSource === 'mock' && s().player.playable,
    );
    check('source: 失败的音源被记录', s().player.failedSources.includes('ghost'));

    actions.player.switchSource('mock');
    await new Promise((resolve) => setTimeout(resolve, 400));
    check('source: 可手动切换音源', s().player.activeSource === 'mock' && s().player.playable);

    /* ---------------- 播放列表（队列）控制 ---------------- */
    const q3 = s().library.local.slice(0, 4);
    actions.player.play(q3[0], [...q3]);
    check('queue: 队列与当前索引就绪', s().player.queue.length === 4 && s().player.index === 0);

    actions.player.moveInQueue(q3[2].id, -1);
    check(
        'queue: 上移与相邻条目交换',
        s().player.queue[1].id === q3[2].id && s().player.queue[2].id === q3[1].id,
    );

    actions.player.moveInQueue(q3[3].id, 1);
    check('queue: 末位下移越界不动', s().player.queue[3].id === q3[3].id);

    actions.player.removeFromQueue(q3[1].id);
    check('queue: 可移除队列条目', !s().player.queue.some((track) => track.id === q3[1].id));

    const queueLen = s().player.queue.length;
    actions.player.removeFromQueue(q3[0].id);
    check('queue: 当前曲目不可移除', s().player.queue.length === queueLen);

    actions.player.clearQueue();
    check(
        'queue: 清空后仅保留当前曲目',
        s().player.queue.length === 1 && s().player.queue[0].id === q3[0].id,
    );

    /* UI 切片 */
    actions.ui.setThemeMode('dark');
    check('store: 主题模式写入', s().ui.themeMode === 'dark');
    actions.ui.setSearchQuery('测试');
    check('store: 搜索词写入', s().ui.searchQuery === '测试');
    actions.ui.toggleGroup('playlists');
    check('store: 分组折叠', s().ui.collapsedGroups.includes('playlists'));
    actions.ui.toggleGroup('playlists');
    check('store: 分组展开', !s().ui.collapsedGroups.includes('playlists'));

    /* 榜单切片：按源加载分类树 → 选中首个分类 → 翻页累加 */
    await actions.ranking.load();
    check(
        'store: 榜单分类树与首页已加载',
        s().ranking.loaded && s().ranking.groups.length > 0 && s().ranking.rows.length > 0,
    );
    check('store: 默认选中第一个分类', s().ranking.selectedId === s().ranking.groups[0].items[0].id);
    check('store: 源说还有下一页', s().ranking.hasMore && s().ranking.nextPage === 2);

    const firstPageCount = s().ranking.rows.length;
    await actions.ranking.loadMore();
    check('store: 加载更多是追加而不是替换', s().ranking.rows.length > firstPageCount);
    check(
        'store: 追加的曲目不重复',
        new Set(s().ranking.rows.map((t) => t.id)).size === s().ranking.rows.length,
    );

    const secondItem = s().ranking.groups[0].items[1];
    if (secondItem) {
        await actions.ranking.selectItem(secondItem.id);
        check(
            'store: 切换分类后重新从第一页开始',
            s().ranking.selectedId === secondItem.id && s().ranking.rows.length === firstPageCount,
        );
    }

    /* 下载切片 */
    await actions.download.load();
    const downloading = s().download.tasks.find((task) => task.status === 'downloading');
    check('store: 下载任务已加载', !!downloading);
    if (downloading) {
        actions.download.pause(downloading.id);
        check('store: 暂停下载', s().download.tasks.find((t) => t.id === downloading.id)?.status === 'paused');
        actions.download.resume(downloading.id);
        check('store: 继续下载', s().download.tasks.find((t) => t.id === downloading.id)?.status === 'downloading');
    }
    const doneCount = s().download.tasks.filter((t) => t.status === 'done').length;
    actions.download.clearFinished();
    check('store: 清理已完成', s().download.tasks.every((t) => t.status !== 'done') && doneCount > 0);

    /* 从列表加入下载队列 */
    const dlTrack = s().library.local[3];
    const tasksBefore = s().download.tasks.length;
    actions.download.add(dlTrack);
    check('store: 加入下载队列', s().download.tasks.some((t) => t.track.id === dlTrack.id));
    actions.download.add(dlTrack);
    check('store: 重复加入下载队列不产生重复项', s().download.tasks.length === tasksBefore + 1);

    const addedTask = s().download.tasks.find((t) => t.track.id === dlTrack.id)!;
    check('store: 新下载任务状态为等待中', addedTask.status === 'pending');
    actions.download.resume(addedTask.id);
    check(
        'store: 等待中任务可直接开始',
        s().download.tasks.find((t) => t.id === addedTask.id)?.status === 'downloading',
    );
    actions.download.remove(addedTask.id);
    check('store: 可移除下载任务', !s().download.tasks.some((t) => t.id === addedTask.id));

    /* 下载引擎：进度推进 → 完成 */
    const runningTasks = s().download.tasks.filter((t) => t.status === 'downloading');
    check('store: 存在下载中的任务（引擎前置条件）', runningTasks.length > 0);

    const progressBefore = runningTasks[0].progress;
    const sizeBefore = runningTasks[0].sizeText;
    actions.download.tick();
    const ticked = s().download.tasks.find((t) => t.id === runningTasks[0].id)!;
    check(
        'store: 下载引擎推进进度并刷新大小文案',
        ticked.progress > progressBefore && ticked.sizeText !== sizeBefore,
    );

    for (let i = 0; i < 40; i += 1) actions.download.tick();
    check('store: 下载可推进到完成', s().download.tasks.every((t) => t.status !== 'downloading'));
    check(
        'store: 完成后进度为 1 且清空速度',
        s()
            .download.tasks.filter((t) => t.status === 'done')
            .every((t) => t.progress === 1 && !t.speedText),
    );

    /* 插件切片 */
    await actions.plugin.load();
    check('store: 插件列表已加载', s().plugin.list.length > 0);
    const target = s().plugin.list.find((p) => !p.builtin)!;
    actions.plugin.setEnabled(target.id, false);
    check('store: 禁用插件', s().plugin.list.find((p) => p.id === target.id)?.enabled === false);
    const version = target.version;
    /* 桌面端这里会去问核心（`plugin.checkUpdate`）；浏览器预览退回 mock 的版本号占位 */
    await actions.plugin.update(target.id);
    check('store: 更新插件版本', s().plugin.list.find((p) => p.id === target.id)?.version !== version);
    actions.plugin.remove(target.id);
    check('store: 内置插件不可卸载', s().plugin.list.some((p) => p.builtin));
    check('store: 第三方插件可卸载', !s().plugin.list.some((p) => p.id === target.id));

    /* 收藏 / 歌单 */
    await actions.collection.load();
    check(
        'collection: 初始收藏与歌单已加载',
        s().collection.loaded && s().collection.favorites.length > 0 && s().collection.playlists.length > 0,
    );

    const favTrack = s().library.local[1];
    const favBefore = actions.collection.isFavorite(favTrack.id);
    actions.collection.toggleFavorite(favTrack);
    check('collection: 收藏状态可切换', actions.collection.isFavorite(favTrack.id) !== favBefore);
    actions.collection.toggleFavorite(favTrack);
    check('collection: 可恢复原收藏状态', actions.collection.isFavorite(favTrack.id) === favBefore);

    const created = actions.collection.createPlaylist('  单测歌单  ');
    check(
        'collection: 新建歌单并去除首尾空格',
        s().collection.playlists[0]?.id === created.id && created.name === '单测歌单' && created.tracks.length === 0,
    );
    check('collection: 新建歌单名称为空时回落默认名', actions.collection.createPlaylist('   ').name.length > 0);

    actions.collection.addToPlaylist(created.id, favTrack);
    check('collection: 加入歌单', s().collection.playlists.find((p) => p.id === created.id)?.tracks.length === 1);
    actions.collection.addToPlaylist(created.id, favTrack);
    check('collection: 重复加入不产生重复项', s().collection.playlists.find((p) => p.id === created.id)?.tracks.length === 1);
    actions.collection.removeFromPlaylist(created.id, favTrack.id);
    check('collection: 移出歌单', s().collection.playlists.find((p) => p.id === created.id)?.tracks.length === 0);

    actions.collection.renamePlaylist(created.id, '改名后');
    check('collection: 重命名歌单', s().collection.playlists.find((p) => p.id === created.id)?.name === '改名后');
    actions.collection.renamePlaylist(created.id, '   ');
    check('collection: 空名称不覆盖原名称', s().collection.playlists.find((p) => p.id === created.id)?.name === '改名后');

    actions.collection.removePlaylist(created.id);
    check('collection: 删除歌单', !s().collection.playlists.some((p) => p.id === created.id));

    /* 导航：设置只保留右上角入口 */
    const menuPaths = buildMenuRoutes(appRoutes).map((item) => item.path);
    check('nav: 侧边栏不再包含 /setting（避免与右上角重复）', !menuPaths.includes('/setting'));
    check('nav: 主题市场不在侧边栏主菜单', !menuPaths.includes('/theme'));
    check('nav: 主菜单为 6 项', menuPaths.length === 6);

    /* ---------------- 二次确认（防误操作） ---------------- */
    let confirmedCount = 0;
    const confirmProbe = {
        titleKey: 'confirm.clearQueueTitle',
        descKey: 'confirm.clearQueueDesc',
        tone: 'danger' as const,
        onConfirm: () => {
            confirmedCount += 1;
        },
    };

    actions.dialog.requestConfirm(confirmProbe);
    check('confirm: 默认进入待确认状态', s().dialog.confirm?.titleKey === confirmProbe.titleKey);
    check('confirm: 未确认前不执行', confirmedCount === 0);
    actions.dialog.resolveConfirm();
    check('confirm: 确认后执行并清空请求', confirmedCount === 1 && s().dialog.confirm === null);

    actions.dialog.requestConfirm(confirmProbe);
    actions.dialog.cancelConfirm();
    check('confirm: 取消不执行', confirmedCount === 1 && s().dialog.confirm === null);

    actions.ui.setConfirmDestructive(false);
    actions.dialog.requestConfirm(confirmProbe);
    check(
        'confirm: 关闭开关后直接执行',
        confirmedCount === 2 && s().dialog.confirm === null,
    );
    actions.ui.setConfirmDestructive(true);

    /* ---------------- 个性化推荐 ---------------- */
    /* 打分算法已经**只在核心实现一份**（浏览器里没有核心），前端这里只验证预置数据的形状
       与「门面安全降级」，真实算法由 `cargo test -p gently-core` 的 recommend 单测覆盖。 */
    check('recommend: 浏览器下推荐门面返回预设数据', (await coreRecommendHome(5)) === null);

    const bundle = await recommendService.suggest({
        recent: s().library.recent,
        favorites: s().collection.favorites,
    });
    check(
        'recommend: 同时给出单曲 / 专辑 / 歌单',
        bundle.tracks.length > 0 && bundle.albums.length > 0 && bundle.playlists.length > 0,
    );
    check('recommend: 专辑带曲目', bundle.albums.every((album) => album.tracks.length > 0));
    check('recommend: 歌单带风格标签', bundle.playlists.every((item) => item.tags.length > 0));
    check('recommend: 推荐理由与画像一致', bundle.tracks.every((item) => item.reason.score >= 0));

    await actions.recommend.load(true);
    check(
        'store: 推荐写入切片',
        s().recommend.loaded && s().recommend.bundle !== null && !s().recommend.loading,
    );

    /* 源侧推荐（`catalog.recommend`）：浏览器里没有核心，演示源必须给出本地实现的结果 */
    await actions.recommend.loadSource();
    check(
        'store: 源侧推荐来自本地演示源（浏览器）',
        s().recommend.sourceLoaded && s().recommend.sourceTracks.length > 0 && !!s().recommend.sourceId,
        `sourceId=${s().recommend.sourceId} count=${s().recommend.sourceTracks.length}`,
    );

    /* 「不感兴趣」：立刻从列表消失（负反馈上报由假宿主那一段断言真实命令） */
    const disliked = s().recommend.bundle?.tracks[0];
    check('recommend: 有可点「不感兴趣」的条目', !!disliked);
    if (disliked) {
        const before = s().recommend.bundle?.tracks.length ?? 0;
        actions.recommend.dislike(disliked);
        check(
            'store: 「不感兴趣」把它从推荐里去掉',
            (s().recommend.bundle?.tracks.length ?? 0) === before - 1 &&
                !s().recommend.bundle?.tracks.some((item) => item.id === disliked.id),
        );
    }

    /* ---------------- 皮肤（复杂主题） ---------------- */
    const roundSkin = resolveSkin(themeConfig, 'round');
    check(
        'skin: 可覆盖圆角与阴影',
        roundSkin.radius.lg !== themeConfig.radius.lg && roundSkin.shadow.md !== themeConfig.shadow.md,
    );
    check('skin: 可覆盖动效与字体度量', roundSkin.motion.base !== themeConfig.motion.base);

    const sharpSkin = resolveSkin(themeConfig, 'sharp');
    check(
        'skin: 未声明的令牌组继承主题配置',
        sharpSkin.spacing['4'] === themeConfig.spacing['4'] &&
            sharpSkin.palette.success === themeConfig.palette.success,
    );
    check(
        'skin: 可覆盖组件度量',
        sharpSkin.components.dataTable.rowMinHeight !== themeConfig.components.dataTable.rowMinHeight,
    );

    const parsedSkin = parseSkin(
        JSON.stringify({id: 'my-skin', name: '我的皮肤', palette: {brand: '#123456'}}),
    );
    check('skin: 合法皮肤可解析', parsedSkin.ok && parsedSkin.skin?.palette?.brand === '#123456');
    check('skin: 非 JSON 被拒绝', parseSkin('{').ok === false);
    check('skin: 缺少必填字段被拒绝', parseSkin(JSON.stringify({name: 'x'})).ok === false);
    check('skin: 导出结果可再次导入', parseSkin(serializeSkin(getThemeSkin('round'))).ok === true);

    actions.ui.installSkin({
        id: 'smoke-skin',
        name: '冒烟皮肤',
        description: '',
        author: 'test',
        swatches: ['#000000'],
        palette: {brand: '#000000'},
    });
    check(
        'store: 导入皮肤后立即应用',
        s().ui.customSkins.some((item) => item.id === 'smoke-skin') &&
            s().ui.themePresetId === 'smoke-skin',
    );
    check(
        'store: 自定义皮肤参与主题解析',
        resolveSkin(themeConfig, 'smoke-skin', s().ui.customSkins).palette.brand === '#000000',
    );
    actions.ui.removeSkin('smoke-skin');
    check(
        'store: 删除皮肤后回到默认皮肤',
        !s().ui.customSkins.some((item) => item.id === 'smoke-skin') &&
            s().ui.themePresetId !== 'smoke-skin',
    );

    /* 皮肤门面：桌面端由**核心**校验（结构 + 令牌键名白名单）；浏览器预览退回本地解析。
       两条路径返回同一形状，视图因此不需要分支。 */
    check('skin: 浏览器下核心皮肤列表为 null', (await skinService.load()) === null);
    const imported = await skinService.importFromText(
        JSON.stringify({id: 'facade-skin', name: '门面皮肤', palette: {brand: '#0a0a0a'}}),
    );
    check('skin: 门面导入成功并给出皮肤对象', imported.ok && imported.skin?.id === 'facade-skin');
    const rejected = await skinService.importFromText('{');
    check('skin: 门面把非法文本当作失败而非抛异常', !rejected.ok && !!rejected.reason);

    check(
        'core: 浏览器下播放上报返回信封而非抛异常',
        (await corePlaybackReport(first, {playedSec: 3})).ok === false,
    );

    /* ---------------- 组件渲染 ---------------- */
    render('TitleBar', <TitleBar/>);
    render('Sidebar', <Sidebar mainMenu={buildMenuRoutes(appRoutes)}/>);
    render('PlayerBar', <PlayerBar/>);
    render('RankingView', <RankingView/>);
    render('HotView', <HotView/>);
    render('DownloadView', <DownloadView/>);
    render('DownloadingView', <DownloadingView/>);
    render('DownloadedView', <DownloadedView/>);
    render('LocalView', <LocalView/>);
    render('PluginView', <PluginView/>);
    render('RecentView', <RecentView/>);
    render('SettingView', <SettingView/>);
    render('ThemeView', <ThemeView/>);
    render('FavoritesView', <FavoritesView/>);
    render('PlaylistView', <PlaylistView/>);
    /* 专辑 / 精选歌单详情：路由参数来自 mock 的 id（含 `:`，所以路径里要编码） */
    render('CollectionView（专辑）', <CollectionView/>, '/collection/album/mock/album%3A%E6%9E%97%E6%B8%85%E9%87%8E');
    render('CollectionView（歌单）', <CollectionView/>, '/collection/curated/mock/curated%3Amidnight');
    render('CollectionView（未知类型）', <CollectionView/>, '/collection/nope/mock/x');
    /* 相似推荐：核心才算得出来，浏览器下必须是空数组（视图因此不渲染这一块） */
    check(
        'recommend: 浏览器下相似推荐为空（没有核心就没有这套算法）',
        (await recommendService.similar({id: 'demo:1', source: 'demo', sourceTrackId: '1'} as never)).length === 0,
    );
    check(
        'recommend: 专辑种子同样返回空',
        (await recommendService.similar({albumId: 'album-x'})).length === 0,
    );

    /* 插件管理面板（凭据 + 配置）：浏览器模式下所有核心门面返回空，
       面板必须照常渲染并给出「没有声明凭据」的说明，而不是崩掉或显示空壳 */
    render(
        'PluginSettings（浏览器模式）',
        <PluginSettings
            plugin={{
                id: 'smoke-plugin',
                name: '冒烟插件',
                version: '1.0.0',
                author: 'test',
                description: 'render only',
                builtin: false,
                enabled: true,
                priority: 10,
                compat: false,
                origin: {kind: 'paste'},
                manifest: {
                    id: 'smoke-plugin',
                    name: '冒烟插件',
                    version: '1.0.0',
                    author: 'test',
                    description: 'render only',
                    qualities: ['standard'],
                    permissions: [],
                    hosts: [],
                    credentials: [],
                    tags: [],
                    capabilities: ['search'],
                },
            }}
        />,
    );

    /* 歌曲详情：先恢复播放，确保歌词面板也有内容可渲染 */
    actions.player.play(s().library.local[2], s().library.local);
    await new Promise((resolve) => setTimeout(resolve, 220));
    render('NowPlayingView（含歌词）', <NowPlayingView/>);
    check('页面：歌曲详情渲染时歌词已就绪', s().player.lyrics.length > 0);

    /* 播放条的两块抽屉 + 独立搜索视图 */
    render('QueuePanel', <QueuePanel onClose={() => undefined}/>);
    render('ActionsPanel', <ActionsPanel onClose={() => undefined}/>);
    render('SourcePicker（有候选音源）', <SourcePicker/>);
    render('QualityPicker（有候选音源）', <QualityPicker/>);
    render('SearchView（无关键词）', <SearchView/>, '/search');
    render('SearchView（带关键词）', <SearchView/>, '/search?q=晚风');
    render(
        'ConfirmDialog',
        <ConfirmDialog
            title="title"
            description="description"
            tone="danger"
            cancelLabel="cancel"
            confirmLabel="ok"
            onConfirm={() => undefined}
            onCancel={() => undefined}
        />,
    );
    render('AlbumGrid', <AlbumGrid albums={[]} onSelect={() => undefined} onPlay={() => undefined}/>);
    render(
        'PlaylistGrid',
        <PlaylistGrid playlists={[]} onSelect={() => undefined} onPlay={() => undefined}/>,
    );
    render('ReasonChip', <ReasonChip reason={{kind: 'tag', value: '深夜', score: 0.8}}/>);

    /* 主题市场：切换预设写入 ui 切片，ThemeProvider 会据此重算 CSS 变量 */
    actions.ui.setThemePreset('sakura');
    check('store: 主题市场预设写入 ui 切片', s().ui.themePresetId === 'sakura');
    actions.ui.setThemePreset(themePresets[0].id);
    check('store: 预设可切回默认', s().ui.themePresetId === themePresets[0].id);

    /* 核心桥接：浏览器（无 Tauri）下必须安全降级，且**永远不抛异常** */
    check('core: 浏览器环境判定为不可用', coreAvailable() === false);
    const bridgeResult = await invokeCore('system.status');
    check('core: 不可用时返回信封而非抛异常', bridgeResult.ok === false);
    check(
        'core: 不可用时的错误码为 unsupported_platform',
        bridgeResult.ok === false && bridgeResult.error.code === 'common.unsupported_platform',
        bridgeResult.ok ? 'unexpected ok' : bridgeResult.error.code,
    );
    check('core: 信封始终带 traceId', typeof bridgeResult.traceId === 'string');

    /* 事件名是跨进程 ABI，且必须落在 Tauri 接受的字符集里（点号会让事件整条丢失：
       流式搜索只能等超时、下载进度永远不动）。契约守卫比 Rust ↔ 文档 ↔ 前端三处，
       这里再钉一次前端的运行时常量——以后有人加事件时点号（`x.y`）会立刻失败。 */
    const eventNames = Object.values(CORE_EVENTS);
    check(
        'core: 事件名都在 Tauri 接受的字符集内（无点号）',
        eventNames.length === 8 && eventNames.every((name) => EVENT_NAME_PATTERN.test(name)),
        eventNames.filter((name) => !EVENT_NAME_PATTERN.test(name)).join(', '),
    );

    /* 核心搜索/播放门面：无桌面宿主时必须安全降级（不请求、不抛异常） */
    const searchResult = await coreSearch('夜曲', {handlers: {onPartial: () => undefined}});
    check('core: 浏览器下搜索门面返回 null 而不抛异常', searchResult === null);

    /* 中止的搜索必须立刻收敛为 null（调用方据此忽略结果），不能挂在那里等超时 */
    const abortedSearch = await coreSearch('晚风', {signal: AbortSignal.abort()});
    check('core: 已中止的搜索立即返回 null', abortedSearch === null);

    const controller = new AbortController();
    const aborting = coreSearch('晚风', {signal: controller.signal});
    controller.abort();
    check('core: 中止后搜索 Promise 收敛', (await aborting) === null);
    const resolved = await coreResolveUrl('demo:1', 'standard');
    check('core: 浏览器下播放解析返回 null 而不抛异常', resolved === null);

    /* 详情门面：同样在无宿主时安全降级为 null（UI 据此退回 mock 或隐藏入口） */
    check('core: 浏览器下曲目详情返回 null', (await coreTrackDetail('demo:1')) === null);
    check('core: 浏览器下专辑详情返回 null', (await coreAlbum('demo', 'a1')) === null);
    check('core: 浏览器下榜单分类树返回 null', (await coreTopLists('demo')) === null);
    check('core: 浏览器下榜单内容返回 null', (await coreTopList('demo', 'hot')) === null);
    check('core: 浏览器下歌词返回 null', (await coreLyrics('demo:1', true)) === null);

    /* 本机库门面：读返回 null（调用方退回 mock），写是安全空操作（不抛异常） */
    check('core: 浏览器下收藏列表返回 null', (await coreLoadFavorites()) === null);
    check('core: 浏览器下歌单列表返回 null', (await coreLoadPlaylists()) === null);
    check('core: 浏览器下最近播放返回 null', (await coreLoadRecent()) === null);
    check('core: 浏览器下本地曲库返回 null', (await coreLoadLocal()) === null);
    const browserTrack = s().library.local[0] ?? s().collection.favorites[0];
    if (browserTrack) {
        const write = await coreSetFavorite(browserTrack, true);
        check('core: 浏览器下收藏写入返回信封而非抛异常', write.ok === false);
        check('core: 浏览器下新建歌单返回 null', (await coreSavePlaylist({name: 'x', tracks: []})) === null);

        /* 下载：命令返回信封、事件订阅是安全空操作（mock 进度由 store 定时器推进） */
        const created = await coreCreateDownload(browserTrack);
        check(
            'core: 浏览器下创建下载返回 unsupported_platform 信封（调用方据此走模拟）',
            created.ok === false && created.error.code === 'common.unsupported_platform',
        );
        const paused = await corePauseDownload('dl-x');
        check('core: 浏览器下下载命令返回信封而非抛异常', paused.ok === false);
        const unsubscribe = await coreListenDownloads({});
        check('core: 浏览器下下载事件订阅返回空退订函数', typeof unsubscribe === 'function');
        unsubscribe();
    }

    /* ---------------- 假宿主：把「桌面端才走得到」的分支也测掉 ----------------
       冒烟跑在 Node（没有 Tauri），因此 `coreAvailable()` 恒为 false，
       「核心优先读」与「核心报错如实呈现」这些分支从来没被执行过——
       而它们正是 `ui.loadSkins` 的 active 纠正、榜单错误提示这类逻辑的所在。
       这里临时装一个假宿主：只替换 `window.__TAURI_INTERNALS__.invoke`，用完立刻恢复现场。 */
    let downloadCreateAttempts = 0;
    const fakeDownloadSeed = s().library.local[0] ?? s().collection.favorites[0] ?? s().player.queue[0];
    /* 假宿主里核心会「读失败」，本地曲库因此为空（R28 的策略）——播放类断言要用这里预抓的曲目 */
    const fakeTrackSeeds = [...s().library.local, ...s().collection.favorites, ...s().player.queue];
    /** 记录核心侧收到的推荐类命令，用于断言「按源路由」与「反馈动作」 */
    const recommendCalls: Record<string, unknown>[] = [];
    const feedbackCalls: Record<string, unknown>[] = [];
    const detailCalls: Record<string, unknown>[] = [];
    const lyricsCalls: Record<string, unknown>[] = [];
    const savePlaylistCalls: Record<string, unknown>[] = [];
    const skinExportCalls: Record<string, unknown>[] = [];
    const skinImportCalls: Record<string, unknown>[] = [];
    const resolveCalls: Record<string, unknown>[] = [];
    const reportCalls: Record<string, unknown>[] = [];
    await withFakeCore(
        (command, params, host) => {
            if (command === 'plugin.list') {
                return envelope([
                    {id: 'core-source', name: '核心音源', version: '9.0.0', enabled: true, builtin: false},
                ]);
            }
            if (command === 'playback.resolve') {
                resolveCalls.push(params);
                return envelope({streamUrl: 'http://127.0.0.1:1/probe', source: 'local', quality: 'standard'});
            }
            if (command === 'playback.report') {
                reportCalls.push(params);
                return envelope(null);
            }
            if (command === 'catalog.track') {
                // 源侧详情：补一个列表快照里没有的封面（真实插件常这么干）
                detailCalls.push(params);
                return envelope(
                    fakeDownloadSeed
                        ? {...fakeDownloadSeed, artwork: 'https://example.com/detail-cover.jpg', album: '详情专辑'}
                        : null,
                );
            }
            if (command === 'catalog.recommend') {
                recommendCalls.push(params);
                return envelope(fakeDownloadSeed ? [fakeDownloadSeed] : []);
            }
            if (command === 'catalog.lyrics') {
                // 歌词：核心只给原文；这里回 null（= 这个源没有歌词），只看有没有被问
                lyricsCalls.push(params);
                return envelope(null);
            }
            if (command === 'recommend.feedback') {
                feedbackCalls.push(params);
                return envelope(null);
            }
            if (command === 'download.list') {
                // `download.list` 返回的是**数组**（不是 Page）；核心报的列表就是列表，
                // 不再是「核心不可用」时那份 mock
                return envelope(
                    fakeDownloadSeed
                        ? [
                              {
                                  id: 'dl-fake-1',
                                  track: fakeDownloadSeed,
                                  status: 'pending',
                                  progress: 0,
                                  totalMb: 4,
                                  sizeText: '0.0 / 4.0 MB',
                              },
                          ]
                        : [],
                );
            }
            if (command === 'library.local.scan') {
                // 与真实核心同形：一次扫描的统计结果；目录不存在 → library.scan_failed。
                // 成功路径**故意慢一点**：真实扫描是长任务，测试要能在「进行中」推一条进度事件
                // （返回得太快的话，订阅在测试推事件之前就退订了——那是测试的错觉，不是产品行为）。
                const dirs = (params.dirs ?? []) as string[];
                if (dirs.some((dir) => dir.includes('nope'))) {
                    return failure('library.scan_failed', '目录不存在');
                }
                return new Promise((resolve) =>
                    setTimeout(
                        () => resolve(envelope({scanned: 12, added: 3, updated: 1, removed: 1, skipped: 7, unreadable: 0, ignored: 2})),
                        50,
                    ),
                );
            }
            if (command === 'library.playlists.save') {
                // 与真实核心同形：**没有 id = 新建**（核心分配 id 并把曲目一起存下来）；
                // **带 id = 整体覆盖**，而这个 id 必须是核心认识的——本地占位 id（`pl:…`）
                // 只会拿到 `common.not_found`（R40 实测：界面提示「已加入」，歌单里却是 0 首）
                savePlaylistCalls.push(params);
                const id = typeof params.id === 'string' ? params.id : '';
                if (id && !id.startsWith('pl-')) {
                    return failure('common.not_found', `歌单不存在：${id}`);
                }
                const tracks = (params.tracks ?? []) as unknown[];
                return envelope({
                    id: id || 'pl-core-1',
                    name: String(params.name ?? ''),
                    createdAt: Date.now(),
                    tracks,
                });
            }
            if (command === 'download.create') {
                // 与真实核心同形：曲目所属的源不在核心里 → not_found（「插件未安装」）
                downloadCreateAttempts += 1;
                return failure('common.not_found', `插件未安装：${String(params.ref ?? '')}`);
            }
            if (command === 'skin.list') {
                return envelope([
                    {
                        id: 'core-skin',
                        name: '核心里的皮肤',
                        description: '',
                        author: 'someone',
                        swatches: ['#123456'],
                        palette: {brand: '#123456'},
                        active: true,
                    },
                ]);
            }
            if (command === 'skin.preview') {
                skinImportCalls.push(params);
                return envelope({
                    skin: {id: 'probe-skin', name: '探针皮肤', description: '', author: 'probe', swatches: ['#ff00ff']},
                    warnings: [],
                });
            }
            if (command === 'skin.install') {
                skinImportCalls.push(params);
                return envelope({
                    id: 'probe-skin',
                    name: '探针皮肤',
                    description: '',
                    author: 'probe',
                    swatches: ['#ff00ff'],
                    builtin: false,
                });
            }
            if (command === 'skin.export') {
                skinExportCalls.push(params);
                return envelope({json: '{"fromCore":true}'});
            }
            if (command === 'catalog.topLists') {
                // 与真实核心同形：清单里没有这个源 → not_found（「插件未安装」），有 → 上游失败
                return params.source === 'core-source'
                    ? failure('source.upstream_failed', '上游 502')
                    : failure('common.not_found', `插件未安装：${String(params.source)}`);
            }
            if (command === 'catalog.topList') {
                return params.source === 'core-source'
                    ? failure('plugin.runtime_error', '插件抛错')
                    : failure('common.not_found', `插件未安装：${String(params.source)}`);
            }
            if (command === 'catalog.search') {
                // 流式搜索用例：用固定 searchId 建搜索，partial/done 由测试自己推（见下面 §9）
                if (params.keyword === STREAM_SEARCH_KEYWORD) {
                    return envelope({searchId: STREAM_SEARCH_ID, sourceCount: 1});
                }
                // **竞态用例**：本地插件几乎瞬时，核心可能在命令返回前就把事件推出来
                if (params.keyword === STREAM_RACE_KEYWORD && fakeDownloadSeed) {
                    host.emit('catalog:search:partial', {
                        searchId: STREAM_SEARCH_ID,
                        source: 'core-source',
                        tracks: [fakeDownloadSeed],
                    });
                    host.emit('catalog:search:done', {
                        searchId: STREAM_SEARCH_ID,
                        items: [
                            {
                                ...fakeDownloadSeed,
                                id: `song:${fakeDownloadSeed.id}`,
                                candidates: [
                                    {source: 'core-source', track: fakeDownloadSeed, qualities: ['standard']},
                                ],
                                sourceCount: 1,
                            },
                        ],
                        sources: ['core-source'],
                        failedSources: [],
                    });
                    return envelope({searchId: STREAM_SEARCH_ID, sourceCount: 1});
                }
                return failure('common.internal', '核心搜索失败（假宿主预设）');
            }
            // 没写到的命令：核心报「未实现」——这正是「预期内失败」的样子
            return failure('common.not_implemented', `未预设：${command}`);
        },
        async (host) => {
            check('fake: 假宿主生效（coreAvailable 应为 true）', coreAvailable());

            /* 桌面端形态的扫描面板（浏览器形态在 LocalView 的渲染里已经覆盖） */
            render('ScanPanel（桌面端形态）', <ScanPanel/>);

            /* 0. mock 只在「没有核心」时才出现：核心在却读失败时，绝不能拿示例数据
               冒充用户的收藏/歌单/本地曲库/下载（那比空列表糟糕得多） */
            check('fake: 核心报错时本地曲库为空而不是 mock 数据', (await libraryService.loadLocal()).length === 0);
            const collectionFallback = await libraryService.loadCollection();
            check(
                'fake: 核心报错时收藏/歌单为空而不是 mock 数据',
                collectionFallback.favorites.length === 0 && collectionFallback.playlists.length === 0,
            );

            /* 1. 插件列表**只有核心那一份**：内置演示源与占位项是前端 mock，
               核心在的时候绝不能被合并进去（否则用户以为装了这些源，点进去什么都没有）。
               注意假宿主是在本文件加载**之后**才装上的，前端注册表里那三个演示源仍在——
               因此这里同时钉住「按注册表列出」与「按核心列出」两条路。 */
            const plugins = await libraryService.loadPlugins();
            const demoIds = ['mock', 'bilibili', 'netease'];
            check(
                'fake: 插件列表只有核心那份（含核心插件、不含内置演示源）',
                plugins.some((plugin) => plugin.id === 'core-source' && !plugin.builtin) &&
                    !plugins.some((plugin) => demoIds.includes(plugin.id)),
                plugins.map((plugin) => plugin.id).join(', '),
            );
            check(
                'fake: 核心在时插件列表不含占位项（qqmusic / kugou）',
                !plugins.some((plugin) => plugin.id === 'qqmusic' || plugin.id === 'kugou'),
            );
            check(
                'fake: 插件列表无重复 id',
                new Set(plugins.map((plugin) => plugin.id)).size === plugins.length,
            );
            /* 界面的「当前音源」走服务层（AGENTS 第 5 条），且读的是**核心那份清单**：
               前端注册表在桌面上是空的，只读注册表会让设置页误报「还没有安装任何插件」。 */
            check(
                'fake: 当前音源读核心清单（不看前端注册表）',
                catalogService.activeSource(plugins)?.id === 'core-source',
                `active=${catalogService.activeSource(plugins)?.id}`,
            );

            /* 2. 核心认识的源走核心：核心报错如实呈现（R18 的行为），不悄悄退回 mock */
            const tree = await catalogService.fetchTopLists('core-source');
            check(
                'fake: 榜单报错时带上原始错误码',
                tree.groups.length === 0 && tree.error?.code === 'source.upstream_failed',
            );
            const page = await catalogService.fetchTopList('core-source', 'hot', 1);
            check(
                'fake: 榜单内容报错时同样如实带出',
                page.page.items.length === 0 && page.error?.code === 'plugin.runtime_error',
            );

            /* 3. 核心**不认识**的源（内置演示源）根本不问核心：
               以前这里会把 `common.not_found`（插件未安装：mock）当成「源跑挂了」，
               界面上只剩一条故障提示——核心里一个音源都没装是**正常状态**，不是故障。 */
            const demoTree = await catalogService.fetchTopLists('mock');
            check(
                'fake: 演示源不问核心，本地拿得到分类树',
                demoTree.groups.length > 0 && demoTree.error === undefined,
                demoTree.error ? `核心理由 ${demoTree.error.code} 被当成故障` : '无分类树',
            );
            const demoPage = await catalogService.fetchTopList('mock', demoTree.groups[0]?.items[0]?.id ?? '', 1);
            check(
                'fake: 演示源榜单内容也走本地',
                demoPage.page.items.length > 0 && demoPage.error === undefined,
            );

            /* 4. 按源搜索的路由：核心的源绝不能静默变成演示数据 */
            const coreOnly = await catalogService.searchIn('晚风', 'core-source');
            check('fake: 核心源的按源搜索失败时返回空而不是演示数据', coreOnly.length === 0);
            const demoOnly = await catalogService.searchIn('晚风', 'mock');
            check('fake: 演示源的按源搜索照常返回本地结果', demoOnly.length > 0);

            /* 5. **核心在时的诚实空态**（本轮的新规则）：`recommend.home` 报「未实现」
               时必须返回**空 bundle**（画像为空 → 界面显示「多听几首再来」），
               而不是 `src/mock/recommend.mock.ts` 里那批预置曲目——那是别人的假数据。 */
            const emptyBundle = await recommendService.suggest({recent: [], favorites: []});
            check(
                'fake: 核心在时推荐为空 bundle 而不是 mock 预置曲目',
                emptyBundle.tracks.length === 0 &&
                    emptyBundle.albums.length === 0 &&
                    emptyBundle.playlists.length === 0 &&
                    emptyBundle.profile.sampleSize === 0,
                `tracks=${emptyBundle.tracks.length} albums=${emptyBundle.albums.length}`,
            );

            /* 6. 皮肤裁决走完整路径（R24 的修复）：核心标了 active 就用核心那套 */
            await actions.ui.loadSkins();
            check(
                'fake: 启动后采用核心标为 active 的皮肤',
                s().ui.customSkins.some((skin) => skin.id === 'core-skin') &&
                    s().ui.themePresetId === 'core-skin',
            );

            /* 6b. 皮肤导出：**内置预设不问核心**（核心只有用户导入的皮肤，拿 `ocean` 去问只会
               换来一条 `common.not_found 皮肤未安装：ocean` 的误导性告警，R43 在打包版日志里看到），
               用户皮肤才取核心那份原文 */
            skinExportCalls.length = 0;
            const builtinJson = await skinService.exportSkin(themePresets[0]);
            check(
                'fake: 导出内置预设不问核心，照样拿到 JSON',
                skinExportCalls.length === 0 && builtinJson.includes(themePresets[0].id),
                `calls=${skinExportCalls.length} json=${builtinJson.slice(0, 60)}`,
            );
            const userJson = await skinService.exportSkin({...themePresets[0], id: 'user-skin', builtin: false});
            check(
                'fake: 导出用户皮肤取核心原文',
                skinExportCalls.length === 1 && userJson.includes('fromCore'),
                JSON.stringify(skinExportCalls),
            );

            /* 6c. 皮肤导入的两条来源（粘贴 JSON / 粘贴本机路径）都要走核心的 `skin.preview` + `skin.install`：
               桌面端没有 Tauri 的 dialog 插件，只靠原生文件选择器会留下一条自动化/受控环境里走不通的路
               （R49 实测：选择器点得开、按钮驱动不了），所以主题市场补了与插件页一致的两种粘贴来源。 */
            skinImportCalls.length = 0;
            const byText = await skinService.importFromText('{"id":"probe-skin","name":"探针皮肤"}');
            check(
                'fake: 粘贴 JSON 导入皮肤走核心（preview + install，来源是 paste）',
                byText.ok &&
                    skinImportCalls.length === 2 &&
                    (skinImportCalls[0].from as {kind?: string}).kind === 'paste',
                JSON.stringify(skinImportCalls.map((call) => call.from)),
            );

            skinImportCalls.length = 0;
            const byPath = await skinService.importFromPath('C:\\skins\\probe-skin.json');
            check(
                'fake: 按本机路径导入皮肤走核心（来源是 file，路径原样带过去）',
                byPath.ok &&
                    skinImportCalls.length === 2 &&
                    (skinImportCalls[0].from as {kind?: string; path?: string}).kind === 'file' &&
                    (skinImportCalls[0].from as {path?: string}).path === 'C:\\skins\\probe-skin.json',
                JSON.stringify(skinImportCalls.map((call) => call.from)),
            );

            /* 7. 下载：核心拒绝建任务时**必须留下原因**（以前是 `if (!created) return`，
               点了下载什么都不发生）；「重试」对本地兜底项 = 重新向核心建一次 */
            const usedIds = new Set(s().download.tasks.map((task) => task.track.id));
            const dlTrack = [...s().library.local, ...s().collection.favorites, ...s().player.queue].find(
                (track) => !usedIds.has(track.id),
            );
            check('fake: 有可用于下载断言的空闲曲目', !!dlTrack);
            if (dlTrack) {
                actions.download.add(dlTrack);
                await new Promise((resolve) => setTimeout(resolve, 0));
                const refused = s().download.tasks.find((task) => task.track.id === dlTrack.id);
                check(
                    'fake: 核心拒绝建任务时留下带错误码的任务（不是静默无反应）',
                    refused?.status === 'error' && refused.errorCode === 'common.not_found',
                    refused ? `${refused.status}/${refused.errorCode ?? '-'}` : '没有任务',
                );

                if (refused) {
                    actions.download.resume(refused.id);
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    check(
                        'fake: 重试本地失败项会重新向核心建任务（而不是假装在下载）',
                        downloadCreateAttempts === 2 &&
                            s().download.tasks.find((task) => task.track.id === dlTrack.id)?.status === 'error',
                        `建任务次数 ${downloadCreateAttempts}`,
                    );

                    /* 8b. `load()` 不能把本机持有的任务冲掉：核心的 `download.list` 只回它自己的任务，
                       `dl:<track.id>` 这类失败项核心根本不知道。以前 `load` 直接覆盖整个列表，
                       于是「点了下载（核心拒绝）→ 打开下载管理」之后那条失败原因就消失了（R42 实测）。 */
                    await actions.download.load({force: true});
                    check(
                        'fake: 刷新下载列表不会丢掉本机失败任务（否则用户看不到失败原因）',
                        s().download.tasks.some(
                            (task) => task.track.id === dlTrack.id && task.status === 'error',
                        ),
                        JSON.stringify(s().download.tasks.map((task) => `${task.id}:${task.status}`)),
                    );

                    /* 8c. 本地文件不提供「下载」入口：核心对 `local:` 会直接拒绝
                       （`common.invalid_argument` 本地曲目不需要下载），按钮点了必然失败 */
                    check(
                        'fake: 本地曲目不提供下载入口（核心必然拒绝，文件已在本机）',
                        canDownload({source: 'local'}) === false && canDownload({source: 'core-source'}),
                    );
                }
            }

            /* 8. 事件链路：下载进度/完成/失败都要落到任务上。
               以前只测到「订阅返回一个退订函数」——事件名对不对、载荷映射对不对，全没测。
               R27 的「点号事件名导致所有事件静默丢失」正是从这个缺口溜过去的。 */
            await actions.download.load({force: true});
            const downloadSubscribed = await waitForSubscription(host, 'download:progress');
            check('fake: 下载事件订阅已登记（progress/done/error 三条）', downloadSubscribed);
            const eventTask = s().download.tasks[0];
            check('fake: 有任务可用于事件断言', !!eventTask);
            if (eventTask) {
                host.emit('download:progress', {
                    id: eventTask.id,
                    received: 1024 * 1024,
                    total: 4 * 1024 * 1024,
                    speed: 512 * 1024,
                });
                const progressing = s().download.tasks.find((task) => task.id === eventTask.id);
                check(
                    'fake: 进度事件把任务标成下载中并换算进度',
                    progressing?.status === 'downloading' && Math.abs((progressing?.progress ?? 0) - 0.25) < 0.01,
                    `${progressing?.status}/${progressing?.progress}`,
                );

                host.emit('download:done', {id: eventTask.id, path: 'C:/tmp/gently-test.mp3', bytes: 4 * 1024 * 1024});
                const finished = s().download.tasks.find((task) => task.id === eventTask.id);
                check(
                    'fake: 完成事件写入落盘路径与 100%',
                    finished?.status === 'done' && finished.path === 'C:/tmp/gently-test.mp3',
                    `${finished?.status}/${finished.path ?? '-'}`,
                );

                host.emit('download:error', {id: eventTask.id, code: 'media.blocked_address', message: '内网地址被拒'});
                const broken = s().download.tasks.find((task) => task.id === eventTask.id);
                check(
                    'fake: 失败事件留下错误码（界面按码走 i18n）',
                    broken?.status === 'error' && broken.errorCode === 'media.blocked_address',
                    `${broken?.status}/${broken?.errorCode ?? '-'}`,
                );
            }

            /* 9. 流式搜索：partial 逐源到达、done 收敛 Promise——
               这条链路的唯一纽带就是**事件名必须完全一致**（R27 的 bug 就死在这里）。 */
            const streamTrack = s().library.local[0] ?? s().collection.favorites[0];
            check('fake: 有曲目可用于流式搜索断言', !!streamTrack);
            if (streamTrack) {
                let partials = 0;
                const streaming = coreSearch(STREAM_SEARCH_KEYWORD, {
                    timeoutMs: 4000,
                    handlers: {
                        onPartial: () => {
                            partials += 1;
                        },
                    },
                });
                const subscribed =
                    (await waitForSubscription(host, 'catalog:search:partial')) &&
                    (await waitForSubscription(host, 'catalog:search:done'));
                check('fake: 订阅了流式搜索的 partial 与 done', subscribed);

                host.emit('catalog:search:partial', {
                    searchId: STREAM_SEARCH_ID,
                    source: 'core-source',
                    tracks: [streamTrack],
                });
                host.emit('catalog:search:done', {
                    searchId: STREAM_SEARCH_ID,
                    items: [
                        {
                            ...streamTrack,
                            id: `song:${streamTrack.id}`,
                            candidates: [{source: streamTrack.source, track: streamTrack, qualities: ['standard']}],
                            sourceCount: 1,
                        },
                    ],
                    sources: ['core-source'],
                    failedSources: [],
                });
                const merged = await streaming;
                check(
                    'fake: done 事件兑现搜索 Promise（合并结果原样带出）',
                    merged?.items.length === 1 && merged.sources[0] === 'core-source',
                    merged ? `items=${merged.items.length}` : 'null',
                );
                check('fake: partial 逐源到达触发 onPartial', partials === 1, `partials=${partials}`);
            }

            /* 10. 前端订阅过的事件名必须都是契约里那几个，且字符集合法
               （假宿主按 Tauri 的规则拒绝了不合法名字，这里再断言一次覆盖面） */
            const contractEvents = new Set<string>(Object.values(CORE_EVENTS));
            check(
                'fake: 前端只订阅契约内且传输合法的事件名',
                host.invalidEvents.length === 0 &&
                    host.subscribedEvents.every((event) => contractEvents.has(event)),
                host.invalidEvents.length > 0
                    ? `非法事件名 ${host.invalidEvents.join(', ')}`
                    : host.subscribedEvents.filter((event) => !contractEvents.has(event)).join(', '),
            );

            /* 11. 本地扫描：这是**唯一**的入库入口，走完整链路
               （命令 + `library:scan.progress` 事件 + 强制重读列表） */
            const scanPromise = actions.library.scan({dirs: ['D:/Music']});
            const scanSubscribed = await waitForSubscription(host, 'library:scan:progress');
            check('fake: 扫描进行中订阅了进度事件', scanSubscribed && s().library.scanning);
            host.emit('library:scan:progress', {dir: 'D:/Music', found: 5, percent: 40});
            check(
                'fake: 扫描进度写进 state（目录 / 已发现 / 百分比）',
                s().library.scanProgress?.dir === 'D:/Music' &&
                    s().library.scanProgress?.found === 5 &&
                    s().library.scanProgress?.percent === 40,
                JSON.stringify(s().library.scanProgress),
            );
            await scanPromise;

            const libraryAfterScan = s().library;
            check(
                'fake: 扫描结束后清空进度（不再显示进行中）',
                libraryAfterScan.scanProgress === null && libraryAfterScan.scanning === false,
                JSON.stringify(libraryAfterScan.scanProgress),
            );
            check(
                'fake: 扫描结果留下统计（新增/更新/移除/跳过）',
                libraryAfterScan.scanSummary?.added === 3 &&
                    libraryAfterScan.scanSummary?.removed === 1 &&
                    libraryAfterScan.scanSummary?.skipped === 7,
                JSON.stringify(libraryAfterScan.scanSummary),
            );
            /* 非音频文件数（R53）：`scanned=0` 与「目录是空的」必须能分辨——
               用户的 `D:\Xun\Music` 里只有一个 `.m4s`，旧版界面只能显示「还没有本地音乐」 */
            check(
                'fake: 扫描统计带上非音频文件数（不再把「有文件但都不是音频」显示成空目录）',
                libraryAfterScan.scanSummary?.ignored === 2,
                JSON.stringify(libraryAfterScan.scanSummary),
            );
            check('fake: 扫描结束后不再显示进行中', libraryAfterScan.scanning === false);

            /* 空输入不发请求；扫描失败把错误留下（界面按错误码说明原因，不静默） */
            await actions.library.scan({dirs: ['   ']});
            check('fake: 空目录不发起扫描', s().library.scanError === null && s().library.scanning === false);

            await actions.library.scan({dirs: ['D:/nope']});
            check(
                'fake: 扫描失败时留下错误码而不是静默',
                s().library.scanError?.code === 'library.scan_failed' && s().library.scanning === false,
                s().library.scanError?.code ?? '没有错误',
            );

            /* 12. 源侧推荐按源路由：核心里有源 → 走 `catalog.recommend`，且带的是核心的源 id */
            await actions.recommend.loadSource(true);
            check(
                'fake: 源侧推荐走核心并带上核心的源',
                recommendCalls.length === 1 &&
                    recommendCalls[0].source === 'core-source' &&
                    s().recommend.sourceId === 'core-source' &&
                    s().recommend.sourceTracks.length === 1,
                JSON.stringify({calls: recommendCalls, sourceId: s().recommend.sourceId}),
            );

            /* 13. 「不感兴趣」→ 核心收到 skip + progress 0（画像下次打分就会压低这类标签） */
            const dislikeTarget = s().recommend.sourceTracks[0];
            check('fake: 有可点「不感兴趣」的源侧推荐', !!dislikeTarget);
            if (dislikeTarget) {
                feedbackCalls.length = 0;
                actions.recommend.dislike(dislikeTarget);
                await new Promise((resolve) => setTimeout(resolve, 0));
                check(
                    'fake: 「不感兴趣」上报 skip 负反馈（progress 0）',
                    feedbackCalls.length === 1 &&
                        feedbackCalls[0].action === 'skip' &&
                        feedbackCalls[0].progress === 0,
                    JSON.stringify(feedbackCalls),
                );
                check('fake: 「不感兴趣」立刻从列表移除', s().recommend.sourceTracks.length === 0);
            }

            /* 14. 播放结算 → 推荐弱信号：切歌时按进度报 skip / complete
               （核心的画像只消费次数与时间，不报这两条，「听 5 秒就切」与「完整听完」没区别） */
            const [first, second] = [fakeTrackSeeds[0], fakeTrackSeeds[1]];
            check('fake: 有曲目可用于播放反馈断言', !!first && !!second);
            if (first && second) {
                feedbackCalls.length = 0;
                actions.player.play(first, [first, second]);
                actions.player.setProgress(5, 100); // 听 5%
                actions.player.play(second, [first, second]);
                await new Promise((resolve) => setTimeout(resolve, 0));
                check(
                    'fake: 听到 5% 就切走 → 报 skip（带真实进度）',
                    feedbackCalls.some(
                        (call) =>
                            call.action === 'skip' &&
                            typeof call.progress === 'number' &&
                            Math.abs(Number(call.progress) - 0.05) < 0.001,
                    ),
                    JSON.stringify(feedbackCalls),
                );

                feedbackCalls.length = 0;
                actions.player.play(first, [first, second]);
                actions.player.setProgress(100, 100); // 听完
                actions.player.play(second, [first, second]);
                await new Promise((resolve) => setTimeout(resolve, 0));
                check(
                    'fake: 播完 → 报 complete（progress 1）',
                    feedbackCalls.some((call) => call.action === 'complete' && call.progress === 1),
                    JSON.stringify(feedbackCalls),
                );
            }

            /* 15. 暂停**不算**倾向：不该产生任何反馈（去接个电话不该压低这首歌的权重） */
            if (first) {
                actions.player.play(first, [first]);
                /* 先等上一次会话的结算落地并清空，只看暂停本身 */
                await flushIpc();
                feedbackCalls.length = 0;
                actions.player.setProgress(10, 100);
                actions.player.toggle(); // 暂停
                await flushIpc();
                check(
                    'fake: 暂停不产生推荐反馈',
                    feedbackCalls.length === 0,
                    `count=${feedbackCalls.length} first=${first?.id} second=${second?.id} current=${s().player.current?.id} playing=${s().player.playing}`,
                );
            }
            /* 16. 曲目详情（`catalog.track`）：列表快照缺封面时，播放时问一次源补上 */
            if (first) {
                const coreTrack = {...first, id: 'core-source:1', source: 'core-source', artwork: undefined};
                detailCalls.length = 0;
                actions.player.play(coreTrack, [coreTrack]);
                await flushIpc();
                check(
                    'fake: 播放核心源的曲目会问一次源侧详情（并带 source:trackId 引用）',
                    detailCalls.length === 1 && detailCalls[0].ref === 'core-source:1',
                    JSON.stringify(detailCalls),
                );
                check(
                    'fake: 详情里的封面写进 player.detail（界面用它渲染封面）',
                    s().player.detail?.artwork === 'https://example.com/detail-cover.jpg',
                    String(s().player.detail?.artwork),
                );

                /* 演示源（核心不认识）不该问核心；切歌后也不能留着上一首的详情 */
                detailCalls.length = 0;
                actions.player.play(first, [first]);
                await flushIpc();
                check(
                    'fake: 演示源曲目不问核心，且切歌后清掉上一首的详情',
                    detailCalls.length === 0 && s().player.detail === null,
                    `calls=${detailCalls.length} detail=${s().player.detail?.id ?? 'null'}`,
                );
            }

            /* 16b. 歌词：只有**核心认识的插件源**才值得问核心。本地文件（`local`）与内置演示源
               都没有插件，问了只会拿到 `not_found`，还在日志里留下误导人的「插件未安装：local」
               ——打包版实测时真的出现过这条告警。 */
            if (first) {
                lyricsCalls.length = 0;
                const coreLyricTrack = {...first, id: 'core-source:2', source: 'core-source'};
                actions.player.play(coreLyricTrack, [coreLyricTrack]);
                await flushIpc();
                check(
                    'fake: 核心源的曲目会问一次歌词（`catalog.lyrics`）',
                    lyricsCalls.length === 1,
                    JSON.stringify(lyricsCalls),
                );

                lyricsCalls.length = 0;
                const localLyricTrack = {...first, id: 'local:lyrics-probe', source: 'local'};
                actions.player.play(localLyricTrack, [localLyricTrack]);
                await flushIpc();
                check(
                    'fake: 本地曲目不问核心要歌词（没有插件，问了只是噪声）',
                    lyricsCalls.length === 0,
                    `calls=${lyricsCalls.length}`,
                );
            }

            /* 16c. 「新建歌单并加入当前曲目」必须**一次写成**：桌面端歌单 id 由核心分配，
               拿本地占位 id 去补写只会得到 `common.not_found`——R40 在打包版上实测到
               「抽屉提示已加入、侧边栏歌单计数是 0、库里 playlist_tracks 也是 0」。 */
            if (first) {
                savePlaylistCalls.length = 0;
                const seeded = {...first, id: 'local:playlist-seed', source: 'local'};
                const created = actions.collection.createPlaylist('冒烟歌单', [seeded]);
                await flushIpc();
                check(
                    'fake: 新建歌单只写一次，且把初值曲目一起交给核心',
                    savePlaylistCalls.length === 1 &&
                        !('id' in savePlaylistCalls[0]) &&
                        ((savePlaylistCalls[0].tracks ?? []) as unknown[]).length === 1,
                    JSON.stringify(savePlaylistCalls),
                );
                const playlist = s().collection.playlists.find((item) => item.id === 'pl-core-1');
                check(
                    'fake: 核心确认后占位 id 换成核心 id，曲目没丢',
                    !!playlist && playlist.id !== created.id && playlist.tracks.length === 1,
                    JSON.stringify(s().collection.playlists),
                );
                actions.collection.removePlaylist('pl-core-1');
                await flushIpc();
            }

            /* 19. 队列最后一首播完也要**结算**：历史（`playback.report`）与推荐正反馈
               （`recommend.feedback complete`）都不能丢——真实应用里播完一首 3 秒的本地曲目，
               日志里一条都没有才发现（R35 修）。 */
            if (fakeTrackSeeds[0]) {
                const only = {...fakeTrackSeeds[0], id: 'local:solo', source: 'local'};
                reportCalls.length = 0;
                feedbackCalls.length = 0;
                actions.player.play(only, [only]);
                await flushIpc();
                actions.player.setProgress(3, 3); // 播到末尾
                actions.player.next(); // 音频引擎的 ended → next()，队列里没有下一首
                await flushIpc();
                check(
                    'fake: 最后一首播完会结算历史与推荐正反馈',
                    reportCalls.length >= 1 &&
                        feedbackCalls.some((call) => call.action === 'complete') &&
                        s().player.playing === false,
                    `report=${reportCalls.length} feedback=${JSON.stringify(feedbackCalls.map((c) => c.action))} playing=${s().player.playing}`,
                );
            }

            /* 18. 本地文件必须交给核心播放（`local:` 是核心自带的伪源）。               R29 的按源路由把它当成「前端源」，于是本地音乐永远退回静音时钟——
               真实应用里点播放没有 `playback.resolve`、也没有回环代理连接才发现（R34 修）。 */
            if (fakeTrackSeeds[0]) {
                const localTrack = {
                    ...fakeTrackSeeds[0],
                    id: `local:${fakeTrackSeeds[0].id}`,
                    source: 'local',
                };
                resolveCalls.length = 0;
                await catalogService.resolveUrl(localTrack, 'standard');
                check(
                    'fake: 本地文件交给核心解析播放地址（local 是核心伪源）',
                    resolveCalls.length === 1 && String(resolveCalls[0].ref).startsWith('local:'),
                    JSON.stringify(resolveCalls),
                );

                resolveCalls.length = 0;
                const demoTrack = {...localTrack, id: 'demo:1', source: 'mock'};
                await catalogService.resolveUrl(demoTrack, 'standard');
                check(
                    'fake: 内置演示源不走核心（避免无意义往返）',
                    resolveCalls.length === 0,
                    JSON.stringify(resolveCalls),
                );
            }

            /* 17. 搜索竞态：核心在 `catalog.search` 返回**之前**就推完事件（本地插件几乎瞬时）。
               修前前端是「先发命令、再订阅」，这段窗口的事件全丢 → 界面卡在「加载中」直到 20s 超时。
               真实应用里就是这么暴露的（装了个瞬时返回的本地插件，搜索永远 0 条）。 */
            const raced = await coreSearch(STREAM_RACE_KEYWORD, {timeoutMs: 2000});
            check(
                'fake: 命令返回前到达的事件也能兑现搜索（先订阅再发命令）',
                raced?.items.length === 1 && raced.sources[0] === 'core-source',
                raced ? `items=${raced.items.length}` : 'null（事件丢了，只能等超时）',
            );
        },
    );
    check('fake: 撤离假宿主后回到浏览器模式', !coreAvailable());
    check('fake: 撤离后门面重新返回 null', (await coreLoadPlaylists()) === null);

    /* 路由表与核心不一致时的**兜底**：核心说「这个源不存在」不算故障。
       真实场景：路由表还没刷新（用户直接进搜索页）、或插件刚被卸载。
       此时按「核心不认识」处理，退回本地实现，而不是把 not_found 当成源故障。 */
    await withFakeCore(
        (command) => {
            if (command === 'plugin.list') {
                // 故意宣称核心里有 `mock`：路由会先把请求发给核心
                return envelope([
                    {id: 'mock', name: '核心也说有 mock', version: '1.0.0', enabled: true, builtin: false},
                ]);
            }
            return failure('common.not_found', `插件未安装：${command}`);
        },
        async () => {
            const stale = await catalogService.fetchTopLists('mock');
            check(
                'fake: 核心回 not_found 时退回本地实现而不是报故障',
                stale.groups.length > 0 && stale.error === undefined,
                stale.error ? `not_found 被当成故障（${stale.error.code}）` : '没有分类树',
            );
        },
    );

    // 假宿主期间改过主题选择，恢复到默认以免影响后面的断言
    actions.ui.setThemePreset(DEFAULT_PRESET_ID);

    console.log(notes.join('\n'));
    if (failures.length > 0) {
        console.error(`\n冒烟测试失败 ${failures.length} 项：`);
        failures.forEach((f) => console.error(` - ${f}`));
        process.exit(1);
    }
    console.log(`\n冒烟测试通过：${notes.length} 项全部成功。`);
}

main().catch((err) => {
    console.error('冒烟测试异常终止：', err);
    process.exit(1);
});
