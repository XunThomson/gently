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

import i18n from '../src/i18n';
import {ThemeProvider} from '../src/theme';
import {resolveTheme, themePresets} from '../src/theme';
import {activeUserSkinId, resolveActivePreset} from '../src/theme';
import {DEFAULT_PRESET_ID} from '../src/theme';
import {store, useActions} from '../src/store';
import {buildCssVars, themeConfig} from '../src/theme/tokens';
import {demoSourcesEnabled, demoSourcesReady, getActiveMusicSource, listMusicSources} from '../src/plugins';
import {catalogService, coreSystem, fileService, libraryService, oauthBegin, oauthCancel, oauthListen, oauthSignOut, oauthStatus, recommendService, skinService, windowService} from '../src/services';
import zh from '../src/i18n/locales/zh.json';
import en from '../src/i18n/locales/en.json';
import {CORE_ERROR_CODES} from '../src/api';
import {CORE_EVENTS, EVENT_NAME_PATTERN} from '../src/services/core.events';
import {filterGroupsBySource, groupTracks} from '../src/utils/track';
import {toLyricLines} from '../src/utils/lyrics';
import {errorText} from '../src/i18n/errors';
import {coverStyle, trackCoverStyle} from '../src/utils/cover';
import type {Track, TrackQuality} from '../src/types';
import type {PluginSummary} from '../src/api';
import {rememberCoreSources as rememberCoreSourceList} from '../src/services/core.sources';
import {canDownload} from '../src/hooks/useTrackActions';
import {pickQuality, pickQualityWithFallback} from '../src/utils/quality';
import {getThemeSkin, parseSkin, resolveTheme as resolveSkin, serializeSkin} from '../src/theme';
import type {ThemeSkin} from '../src/theme';

import {TitleBar, Toolbar} from '../src/components/shell/title-bar';
import {Sidebar} from '../src/components/shell/sidebar';
import {PlayerBar, shouldOpenNowPlaying} from '../src/components/shell/player-bar';
import {DesktopLyricsApp, LyricsLineView, type DesktopLyricsPayload} from '../src/widgets/desktop-lyrics';
import {desktopLyricsPayload} from '../src/hooks/useDesktopLyricsBridge';
import {
    defaultLyricsPosition,
    LYRICS_BOTTOM_MARGIN,
    placeLyrics,
} from '../src/utils/lyricsWindowPosition';
import {lyricLineProgress} from '../src/utils/lyrics';
import {
    LYRICS_OFFSET_FINE_STEP_SEC,
    LYRICS_OFFSET_STEP_SEC,
    lyricsOffsetForKey,
} from '../src/utils/lyricsOffset';
import {
    appliedLyricsRef,
    clearLyricsChoice,
    rawTrackIdOf,
    readLyricsSync,
    saveLyricsChoice,
    saveLyricsQuery,
} from '../src/utils/lyricsSyncCache';
import {
    LYRICS_SETTINGS_KEY,
    readLyricsWindowSettings,
    writeLyricsWindowSettings,
} from '../src/utils/lyricsWindowSettings';
import {clearPets, listPets, PetHost, petPlaybackSnapshot, registerPet} from '../src/pet';
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
import {kindFromPath} from '../src/views/plugin/components/import-panel';
import {PluginSettings} from '../src/views/plugin/components/plugin-settings';
import RecentView from '../src/views/recent';
import SettingView from '../src/views/setting';
import ThemeView from '../src/views/theme';
import FavoritesView from '../src/views/favorites';
import {SourceFavorites} from '../src/views/favorites/components/source-favorites';
import {CollectionPicker} from '../src/views/favorites/components/collection-picker';
import {DownloadMark} from '../src/components/ui/download-mark';
import PlaylistView from '../src/views/playlist';
import CollectionView from '../src/views/collection';
import NowPlayingView from '../src/views/now-playing';
import {LyricsToolsDrawer, initialSearchState} from '../src/views/now-playing/components/LyricsToolsDrawer';
import {
    cachedLyricSearchCount,
    clearCachedLyricSearch,
    readCachedLyricSearch,
    saveCachedLyricSearch,
} from '../src/utils/lyricsSearchCache';
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

    /* 插件抛出的错：文案必须带上**插件作者写的说明**，否则用户只看到「插件执行出错」
       （R68：B 站收藏夹缺 Cookie 时那句「需要登录：…」被吞掉，用户无从下手） */
    {
        const t = i18n.getFixedT('zh');
        const withMessage = errorText(t, {
            code: 'plugin.runtime_error',
            message: '需要登录：在插件设置里填写 Cookie 后重试',
        });
        check(
            'i18n: 插件错误的说明会拼进文案（不再只剩通用提示）',
            withMessage.includes('需要登录') && withMessage.includes(t('errors.plugin_runtime_error')),
            withMessage,
        );
        const plainNotFound = errorText(t, {code: 'common.not_found', message: 'track:probe'});
        check(
            'i18n: 非插件码不把开发者说明塞给用户',
            plainNotFound === t('errors.common_not_found') && !plainNotFound.includes('track:probe'),
            plainNotFound,
        );
    }
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

    /* 下载的缺档策略：设置页可选「往更低」或「往更高」，方向优先、另一方向兜底 */
    check(
        'quality: 首选档位可用时不改档',
        pickQualityWithFallback(['standard', 'high'], 'high', 'lower') === 'high',
    );
    check(
        'quality: 缺档且选择「更低」时取最近的更低档',
        pickQualityWithFallback(['standard', 'high'], 'lossless', 'lower') === 'high',
    );
    check(
        'quality: 缺档且选择「更高」时取最近的更高档',
        pickQualityWithFallback(['lossless', 'hires'], 'standard', 'higher') === 'lossless',
    );
    check(
        'quality: 所选方向没有档位时改用另一方向',
        pickQualityWithFallback(['hires'], 'standard', 'lower') === 'hires',
    );
    check(
        'quality: 来源没说支持哪些档位时保留首选',
        pickQualityWithFallback([], 'hires', 'lower') === 'hires',
    );

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

    check(
        'store: 下载设置的默认值来自 appConfig',
        s().ui.downloadDir === '' &&
            s().ui.downloadQuality === 'high' &&
            s().ui.downloadQualityFallback === 'lower' &&
            s().ui.downloadMaxConcurrent === 3,
    );
    actions.ui.setDownloadMaxConcurrent(99);
    check('store: 并发数越界被钳到最大可选档', s().ui.downloadMaxConcurrent === 4);
    actions.ui.setDownloadMaxConcurrent(3);

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

    /* 歌词来源与时间轴校正：自动歌词带来源；手动挑选的歌词不被随后到达的自动歌词覆盖 */
    actions.player.play(first, s().library.local);
    await new Promise((resolve) => setTimeout(resolve, 220));
    check(
        'store: 自动歌词带上来源信息',
        s().player.lyricsSource?.source === first.source && s().player.lyricsSource?.title === first.title,
    );

    actions.player.play(first, s().library.local);
    actions.player.applyLyrics(
        [{time: 1, text: '手动挑的第一句'}],
        {source: 'other-source', sourceName: '别的源', title: '另一个条目', artist: '别人'},
    );
    await new Promise((resolve) => setTimeout(resolve, 220));
    check(
        'store: 手动挑选的歌词覆盖自动歌词且不被迟到的自动结果覆盖',
        s().player.lyrics.length === 1 &&
            s().player.lyrics[0].text === '手动挑的第一句' &&
            s().player.lyricsSource?.source === 'other-source',
    );

    actions.player.setLyricsOffset(1.5);
    check('store: 歌词偏移可设置', s().player.lyricsOffset === 1.5);
    actions.player.setLyricsOffset(999);
    check('store: 歌词偏移被钳到上限（不产生荒谬值）', s().player.lyricsOffset === 30);
    actions.player.setLyricsOffset(0);

    /* 连续微调：每次都基于**最新**偏移累加（闭包里的旧值会让连点 5 下只生效 1 下） */
    {
        actions.player.nudgeLyricsOffset(LYRICS_OFFSET_FINE_STEP_SEC);
        actions.player.nudgeLyricsOffset(LYRICS_OFFSET_FINE_STEP_SEC);
        actions.player.nudgeLyricsOffset(-LYRICS_OFFSET_STEP_SEC);
        check(
            'store: 连续微调按最新值累加',
            Math.abs(s().player.lyricsOffset - (LYRICS_OFFSET_FINE_STEP_SEC * 2 - LYRICS_OFFSET_STEP_SEC)) < 1e-9,
            String(s().player.lyricsOffset),
        );
        actions.player.nudgeLyricsOffset(999);
        check('store: 连续微调也被钳在上限内', s().player.lyricsOffset === 30);
        actions.player.setLyricsOffset(0);
    }
    check(
        'store: 切歌后读回该曲目的偏移（默认 0）',
        (() => {
            const next = s().player.queue.find((track) => track.id !== first.id) ?? first;
            actions.player.play(next, s().player.queue);
            const offset = s().player.lyricsOffset;
            actions.player.stop();
            return offset === 0;
        })(),
    );
    actions.player.play(first, s().library.local);

    /* 桌面歌词载荷：当前行 / 下一行 / 译文 / 来源 / 偏移都从同一份播放器状态算出 */
    {
        const current = {...first, playId: 99};
        const base = {
            ...s().player,
            current,
            lyrics: [
                {time: 1, text: '第一句'},
                {time: 5, text: '第二句', translation: 'second line'},
                {time: 9, text: '第三句'},
            ],
            elapsed: 6,
            lyricsOffset: 0,
            playing: true,
            lyricsSource: {
                source: 'probe-source',
                sourceName: '探针源',
                title: current.title,
                artist: current.artist,
            },
        };
        const payload: DesktopLyricsPayload = desktopLyricsPayload(base);
        check(
            'desktop lyrics: 载荷给出当前行 / 下一行 / 译文 / 来源',
            payload.line === '第二句' &&
                payload.next === '第三句' &&
                payload.translation === 'second line' &&
                payload.source === '探针源' &&
                payload.empty === false &&
                payload.playing,
            JSON.stringify(payload),
        );
        const shifted = desktopLyricsPayload({...base, lyricsOffset: 4});
        check(
            'desktop lyrics: 时间轴偏移参与高亮判断',
            shifted.line === '第三句' && shifted.next === '',
            JSON.stringify(shifted),
        );

        /* 逐字展开需要的「行时间窗」必须随载荷过去（窗口自己按墙钟插值，不能靠主窗口 30Hz 推） */
        check(
            'desktop lyrics: 载荷带当前行的起止时间与显示设置',
            payload.lineStart === 5 &&
                payload.lineEnd === 9 &&
                payload.elapsed === 6 &&
                payload.background === 'solid' &&
                payload.sweep === false,
            JSON.stringify({lineStart: payload.lineStart, lineEnd: payload.lineEnd, elapsed: payload.elapsed}),
        );
        const swept = desktopLyricsPayload(base, 'dark', {background: 'transparent', sweep: true});
        check(
            'desktop lyrics: 设置里的背景与逐字展开会进载荷',
            swept.background === 'transparent' && swept.sweep === true && swept.themeMode === 'dark',
            JSON.stringify({bg: swept.background, sweep: swept.sweep}),
        );
        check(
            'desktop lyrics: 最后一行没有下一行时给一个兜底收尾时间',
            desktopLyricsPayload({...base, elapsed: 10, lyricsOffset: 0}).lineEnd > 9,
        );
    }

    /* 逐字展开的渲染：两层同一段文字 + 按进度裁切（冒烟里能直接断言的 DOM 形状） */
    {
        const sweeping = renderToString(
            <LyricsLineView line="第一句歌词" progress={0.4} sweep scale={1}/>,
        );
        check(
            'desktop lyrics: 逐字展开时渲染两层文字，上层按进度裁切',
            sweeping.includes('第一句歌词') &&
                (sweeping.match(/第一句歌词/g) ?? []).length === 2 &&
                sweeping.includes('clip-path:inset(0 60% 0 0)'),
            sweeping,
        );
        const plain = renderToString(<LyricsLineView line="第一句歌词" progress={0.4} sweep={false} scale={1}/>);
        check(
            'desktop lyrics: 关闭逐字展开时只有一层文字',
            (plain.match(/第一句歌词/g) ?? []).length === 1 && !plain.includes('clip-path'),
            plain,
        );
    }

    /* 逐字展开的进度（纯函数）：越界夹紧、退化区间不产生负宽度 */
    {
        check('lyrics: 行进度在区间内按比例', lyricLineProgress(10, 20, 15) === 0.5);
        check('lyrics: 行进度在开始前为 0、结束后为 1', lyricLineProgress(10, 20, 5) === 0 && lyricLineProgress(10, 20, 25) === 1);
        check('lyrics: 退化区间（同一时间戳）不会算出负数', lyricLineProgress(10, 10, 9) === 0 && lyricLineProgress(10, 10, 11) === 1);
        check('lyrics: 非法输入一律 0', lyricLineProgress(Number.NaN, 20, 15) === 0);
    }

    /* 歌词搜索结果的会话级缓存：切走再回来不用重新搜（用户报的「回来还得再搜一遍」） */
    {
        const result = {
            items: [
                {
                    source: 'src-a',
                    sourceName: '源 A',
                    track: {id: 'src-a:1', source: 'src-a', title: '探针歌', artist: '探针', album: '', durationSec: 100},
                    lyrics: {format: 'lrc', content: '[00:01.00]第一句'},
                },
            ],
            searchedSources: ['src-a'],
            failedSources: [],
            skippedSources: [],
            timedOutSources: [],
        };
        clearCachedLyricSearch();
        check('lyrics search cache: 没搜过时取不到', readCachedLyricSearch('src-a:1') === null);
        saveCachedLyricSearch('src-a:1', result);
        check(
            'lyrics search cache: 存进去能原样取回（含歌词正文）',
            readCachedLyricSearch('src-a:1')?.items[0]?.lyrics.content === '[00:01.00]第一句',
            JSON.stringify(readCachedLyricSearch('src-a:1')?.items.length),
        );
        check(
            'lyrics search cache: 别的曲目不受影响',
            readCachedLyricSearch('src-a:2') === null,
        );
        for (let i = 0; i < 10; i += 1) saveCachedLyricSearch(`src-a:extra-${i}`, result);
        check(
            'lyrics search cache: 只留最近 8 首（不会无限涨）',
            cachedLyricSearchCount() === 8,
            String(cachedLyricSearchCount()),
        );
        check(
            'lyrics search cache: 超上限时丢最早写入的',
            readCachedLyricSearch('src-a:1') === null && readCachedLyricSearch('src-a:extra-9') !== null,
        );
        clearCachedLyricSearch();

        /* 抽屉打开时的初始状态 = 关键词 + 上次的搜索结果 */
        const track = {
            id: 'src-a:refresh',
            source: 'src-a',
            title: '探针歌',
            artist: '探针',
            album: '',
            durationSec: 100,
        } as unknown as Track;
        saveCachedLyricSearch(track.id, result);
        const seeded = initialSearchState(track);
        check(
            'lyrics drawer: 回到这首曲目时带出上次的搜索状态',
            seeded.result?.items.length === 1 && seeded.query.includes('探针歌'),
            JSON.stringify({items: seeded.result?.items.length, query: seeded.query}),
        );
        clearCachedLyricSearch();
    }

    /* 收藏夹选择器：收起时只有一个触发器（上千个收藏夹也不会铺开） */
    {
        const many = Array.from({length: 1000}, (_, index) => ({
            id: `fav-${index}`,
            title: `收藏夹 ${index}`,
            count: index,
        }));
        const html = renderToString(
            <MemoryRouter>
                <ThemeProvider>
                    <CollectionPicker options={many} value="fav-42" onChange={() => undefined}/>
                </ThemeProvider>
            </MemoryRouter>,
        );
        const t = i18n.getFixedT('zh');
        check(
            'favorites: 收藏夹选择器收起时只显示当前收藏夹与总数',
            html.includes('收藏夹 42') &&
                html.includes(t('page.favorites.collectionTotal', {count: 1000})) &&
                !html.includes('收藏夹 43'),
            html.length.toString(),
        );
        check(
            'favorites: 上千个收藏夹也不会一次性渲染（抽屉未展开时列表不在 DOM 里）',
            (html.match(/收藏夹 \d+/g) ?? []).length <= 2,
            String((html.match(/收藏夹 \d+/g) ?? []).length),
        );
    }

    /* 本机路径导入的形态默认值：按扩展名猜（R68 之前默认「压缩包」，导入单文件直接报格式不合法） */
    {
        check(
            'plugin: 路径形态按扩展名猜（.zip → 压缩包，其余 → 单文件）',
            kindFromPath('C:\\x\\bili-audio.js') === 'file' &&
                kindFromPath('D:/a/Plugin.ZIP') === 'archive' &&
                kindFromPath('  release\\plugins\\x.js  ') === 'file',
            `${kindFromPath('a.zip')},${kindFromPath('a.js')}`,
        );
    }

    /* 歌词工具抽屉：方向键微调（纯函数）+ 同步参数缓存 */
    {
        check(
            'lyrics: 方向键微调（→ 更晚 / ← 更早，Shift 粗调，其它键不接管）',
            lyricsOffsetForKey('ArrowRight', false) === LYRICS_OFFSET_FINE_STEP_SEC &&
                lyricsOffsetForKey('ArrowLeft', false) === -LYRICS_OFFSET_FINE_STEP_SEC &&
                lyricsOffsetForKey('ArrowRight', true) === LYRICS_OFFSET_STEP_SEC &&
                lyricsOffsetForKey('ArrowUp', false) === null &&
                lyricsOffsetForKey('a', true) === null,
        );

        const globalScope = globalThis as unknown as {localStorage?: Storage};
        const backup = globalScope.localStorage;
        const values = new Map<string, string>();
        globalScope.localStorage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, String(value)),
            removeItem: (key: string) => void values.delete(key),
            clear: () => values.clear(),
            key: (index: number) => [...values.keys()][index] ?? null,
            get length() {
                return values.size;
            },
        } as Storage;

        const choice = {
            source: 'src-a',
            trackId: '42',
            sourceName: '源 A',
            title: '那首歌',
            artist: '那个人',
        };
        saveLyricsChoice('local:42', choice);
        check(
            'lyrics sync: 记住手动挑的歌词来路',
            readLyricsSync('local:42').applied?.sourceName === '源 A' &&
                readLyricsSync('local:42').applied?.trackId === '42',
            JSON.stringify(readLyricsSync('local:42')),
        );
        check('lyrics sync: 来路能拼成歌词引用', appliedLyricsRef(choice) === 'src-a:42');
        /* 核心给的 `track.id` 已经是 `source:rawId`：原样存进来也必须拼成同一条引用，
           否则会拼出 `src-a:src-a:42` 这种永远取不到词的引用（R68 实测踩过） */
        check(
            'lyrics sync: 完整引用形态也能拼对（不重复加前缀）',
            appliedLyricsRef({...choice, trackId: 'src-a:42'}) === 'src-a:42' &&
                rawTrackIdOf('src-a', 'src-a:42') === '42' &&
                rawTrackIdOf('src-a', '42') === '42',
            appliedLyricsRef({...choice, trackId: 'src-a:42'}),
        );

        saveLyricsQuery('local:42', '  海阔天空  ');
        check(
            'lyrics sync: 关键词去掉首尾空白后记住，且不覆盖来路',
            readLyricsSync('local:42').query === '海阔天空' && readLyricsSync('local:42').applied?.source === 'src-a',
            JSON.stringify(readLyricsSync('local:42')),
        );

        clearLyricsChoice('local:42');
        check(
            'lyrics sync: 忘掉来路但保留关键词',
            readLyricsSync('local:42').applied === undefined && readLyricsSync('local:42').query === '海阔天空',
            JSON.stringify(readLyricsSync('local:42')),
        );

        values.set('gently:lyrics-sync', '{坏的 JSON');
        check('lyrics sync: 坏数据按空处理（不抛异常）', Object.keys(readLyricsSync('local:42')).length === 0);
        values.set(
            'gently:lyrics-sync',
            JSON.stringify({'local:42': {applied: {source: 'x'}, query: '  '}}),
        );
        check(
            'lyrics sync: 字段不全的来路与空关键词被丢弃',
            readLyricsSync('local:42').applied === undefined && readLyricsSync('local:42').query === undefined,
        );

        if (backup === undefined) delete globalScope.localStorage;
        else globalScope.localStorage = backup;
    }

    /* 记住的来路要真的用上：播放同一首时先按这条来路取词，而不是源自动给的词 */
    {
        const cached = {...s().library.local[0], id: 'zz-cached:777', source: 'zz-cached'};
        const refs: string[] = [];
        const globalScope = globalThis as unknown as {localStorage?: Storage};
        const backup = globalScope.localStorage;
        const values = new Map<string, string>();
        globalScope.localStorage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, String(value)),
            removeItem: (key: string) => void values.delete(key),
            clear: () => values.clear(),
            key: (index: number) => [...values.keys()][index] ?? null,
            get length() {
                return values.size;
            },
        } as Storage;
        saveLyricsChoice('zz-cached:777', {
            source: 'remembered-src',
            /* 故意用**完整引用**形态：核心给的 `item.track.id` 就是这样，必须归一化后再拼 */
            trackId: 'remembered-src:remembered-track',
            sourceName: '记住的源',
            title: '记住的标题',
            artist: '记住的歌手',
        });
        /* 让「自动歌词」这条路真的会问核心：核心要认得这个源（`isCoreSource` 的判定依据） */
        rememberCoreSourceList([{id: 'zz-cached', enabled: true} as unknown as PluginSummary]);

        await withFakeCore(
            (command, params) => {
                if (command === 'catalog.lyrics') {
                    refs.push(String((params as {ref?: string}).ref ?? ''));
                    return envelope({format: 'lrc', content: '[00:01.00]记住的那一句'});
                }
                return failure('common.not_found', `未预置：${command}`);
            },
            async () => {
                actions.player.play(cached, [cached]);
                await new Promise((resolve) => setTimeout(resolve, 60));
                check(
                    'store: 播放时先按记住的来路取词（而不是源自动的词）',
                    refs.includes('remembered-src:remembered-track') &&
                        s().player.lyrics[0]?.text === '记住的那一句' &&
                        s().player.lyricsSource?.sourceName === '记住的源',
                    JSON.stringify({refs, lines: s().player.lyrics, source: s().player.lyricsSource}),
                );

                actions.player.restoreAutoLyrics();
                await new Promise((resolve) => setTimeout(resolve, 60));
                check(
                    'store: 「改回源歌词」清掉缓存并回到源自动的词',
                    readLyricsSync('zz-cached:777').applied === undefined &&
                        refs.some((ref) => ref === 'zz-cached:777'),
                    JSON.stringify(refs),
                );
                actions.player.stop();
            },
        );

        /* 撤离时把「核心认识的源」也清掉，后面的用例仍按浏览器模式跑 */
        rememberCoreSourceList(null);
        if (backup === undefined) delete globalScope.localStorage;
        else globalScope.localStorage = backup;
    }

    /* 歌词页：工具抽屉默认**不挂载**（惰性），展开后才出现搜索框与校正按钮 */
    {
        actions.player.play(first, s().library.local);
        const page = renderToString(
            <MemoryRouter>
                <ThemeProvider>
                    <NowPlayingView/>
                </ThemeProvider>
            </MemoryRouter>,
        );
        check(
            'now-playing: 默认收起时工具抽屉不挂载（歌词页只有封面 + 歌词）',
            !page.includes('type="text"') && page.includes(first.title.slice(0, 1)),
            page.length.toString(),
        );

        const closed = renderToString(<LyricsToolsDrawer open={false}/>);
        const opened = renderToString(<LyricsToolsDrawer open/>);
        check(
            'now-playing: 抽屉收起时只隐藏不卸载',
            closed.includes('hidden') && !opened.includes('hidden'),
            JSON.stringify({closedHidden: closed.includes('hidden')}),
        );
        check(
            'now-playing: 抽屉默认只挂「时间轴校正」一格（搜索那格惰性挂载）',
            opened.includes('role="tablist"') &&
                (opened.match(/role="tab"/g) ?? []).length === 3 &&
                !opened.includes('type="text"'),
            String((opened.match(/role="tab"/g) ?? []).length),
        );

        /* 校正按钮的步长：细调 0.1 / 粗调 0.5 都在（文案随语言，按 aria-label 断） */
        check(
            'now-playing: 抽屉里同时有细调与粗调按钮',
            opened.includes(`aria-label="-${LYRICS_OFFSET_FINE_STEP_SEC}"`) &&
                opened.includes(`aria-label="+${LYRICS_OFFSET_STEP_SEC}"`),
            opened.length.toString(),
        );
    }

    /* 桌面歌词显示设置：默认值保守（不透明 / 关闭逐字），坏数据退回默认 */
    {
        const globalScope = globalThis as unknown as {localStorage?: Storage};
        const backup = globalScope.localStorage;
        const values = new Map<string, string>();
        globalScope.localStorage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, String(value)),
            removeItem: (key: string) => void values.delete(key),
            clear: () => values.clear(),
            key: (index: number) => [...values.keys()][index] ?? null,
            get length() {
                return values.size;
            },
        } as Storage;

        const defaults = readLyricsWindowSettings();
        check(
            'lyrics settings: 默认不透明背景且不开启逐字展开',
            defaults.background === 'solid' && defaults.sweep === false,
            JSON.stringify(defaults),
        );
        const written = writeLyricsWindowSettings({background: 'transparent', sweep: true});
        check(
            'lyrics settings: 写入后可读回',
            written.background === 'transparent' &&
                written.sweep === true &&
                readLyricsWindowSettings().background === 'transparent',
            JSON.stringify(written),
        );
        values.set(LYRICS_SETTINGS_KEY, '{"background":"bogus","sweep":"yes"}');
        const repaired = readLyricsWindowSettings();
        check(
            'lyrics settings: 坏数据退回默认值（不把非法背景传给窗口）',
            repaired.background === 'solid' && repaired.sweep === false,
            JSON.stringify(repaired),
        );

        if (backup === undefined) delete globalScope.localStorage;
        else globalScope.localStorage = backup;
    }

    /* 桌面歌词窗口的摆放规则（纯函数）：记得的位置可用就用，不可见就回到底部居中 */
    {
        const monitor = {position: {x: 0, y: 0}, size: {width: 1920, height: 1080}};
        const size = {width: 760, height: 160};
        const fallback = defaultLyricsPosition([monitor], size);
        check(
            'desktop lyrics: 没记过位置时底部居中（留出底边距）',
            fallback.x === Math.round((1920 - 760) / 2) &&
                fallback.y === 1080 - 160 - LYRICS_BOTTOM_MARGIN,
            JSON.stringify(fallback),
        );

        const remembered = {x: 120, y: 300};
        check(
            'desktop lyrics: 记得的位置可用就原样使用',
            JSON.stringify(placeLyrics(remembered, [monitor], size)) === JSON.stringify(remembered),
            JSON.stringify(placeLyrics(remembered, [monitor], size)),
        );

        // 副屏被拔 / 换分辨率：旧坐标不在任何屏幕里 → 回到底部居中，不能放到看不见的地方
        const offscreen = {x: 4000, y: 2600};
        check(
            'desktop lyrics: 记住的位置已经不在屏幕里时回退到底部居中',
            JSON.stringify(placeLyrics(offscreen, [monitor], size)) === JSON.stringify(fallback),
            JSON.stringify(placeLyrics(offscreen, [monitor], size)),
        );

        // 大部分还在屏幕里、但右边/下边露出去一点：夹回屏幕内，保证整条歌词可见
        const halfOff = {x: 1220, y: 980};
        const clamped = placeLyrics(halfOff, [monitor], size);
        check(
            'desktop lyrics: 大半可见的位置被夹回屏幕内',
            clamped.x === 1920 - 760 && clamped.y === 1080 - 160,
            JSON.stringify(clamped),
        );

        // 大半已经出屏（拖出去太多）：宁可回退到底部居中，也不要露出半条看不见的歌词
        const mostlyOff = {x: 1500, y: 1020};
        check(
            'desktop lyrics: 大半出屏时回退到底部居中',
            JSON.stringify(placeLyrics(mostlyOff, [monitor], size)) === JSON.stringify(fallback),
            JSON.stringify(placeLyrics(mostlyOff, [monitor], size)),
        );

        // 第二块屏幕：落在它上面的位置也算「可见」
        const second = {position: {x: 1920, y: 0}, size: {width: 1280, height: 720}};
        const onSecond = {x: 2100, y: 200};
        check(
            'desktop lyrics: 副屏上的位置同样被认可',
            JSON.stringify(placeLyrics(onSecond, [monitor, second], size)) === JSON.stringify(onSecond),
            JSON.stringify(placeLyrics(onSecond, [monitor, second], size)),
        );
    }

    /* 桌面歌词「锁定（点击穿透）」：浏览器里没有窗口，但状态必须如实保存与回读，
       否则设置页会显示一个永远打不开的开关 */
    {
        // Node 里没有 localStorage：装一个最小实现（与浏览器同名同形），用完删掉
        const globalScope = globalThis as unknown as {localStorage?: Storage};
        const backup = globalScope.localStorage;
        const values = new Map<string, string>();
        globalScope.localStorage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => void values.set(key, String(value)),
            removeItem: (key: string) => void values.delete(key),
            clear: () => values.clear(),
            key: (index: number) => [...values.keys()][index] ?? null,
            get length() {
                return values.size;
            },
        } as Storage;

        check('desktop lyrics: 默认未锁定', windowService.desktopLyricsLocked() === false);
        const locked = await windowService.setDesktopLyricsLocked(true);
        check(
            'desktop lyrics: 锁定状态被持久化',
            locked === true && windowService.desktopLyricsLocked() === true,
            String(windowService.desktopLyricsLocked()),
        );
        await windowService.setDesktopLyricsLocked(false);
        check('desktop lyrics: 可以再解锁（解锁入口在设置页）', windowService.desktopLyricsLocked() === false);

        if (backup === undefined) delete globalScope.localStorage;
        else globalScope.localStorage = backup;
    }

    /* 2.x 宠物接口（当前无内置宠物）：宿主零成本、注册表与只读快照可用 */
    {
        check('pet: 未注册宠物时宿主不渲染任何东西', renderToString(<PetHost/>) === '');

        const pet = {
            id: 'smoke-pet',
            name: '冒烟宠物',
            version: '0.1.0',
            mount: () => ({dispose: () => undefined}),
        };
        const unregister = registerPet(pet);
        check(
            'pet: 注册后宿主出现容器',
            listPets().length === 1 && renderToString(<PetHost/>).includes('data-pet-host'),
        );
        const unregisterReplacement = registerPet({...pet, name: '冒烟宠物（覆盖）'});
        check('pet: 同 id 覆盖而不是重复', listPets().length === 1 && listPets()[0].name === '冒烟宠物（覆盖）');
        // 旧注册返回的注销函数不应误删「覆盖后」的新宠物
        unregister();
        check('pet: 旧的注销函数不会删掉覆盖后的注册', listPets().length === 1);
        unregisterReplacement();
        check('pet: 注销后注册表清空', listPets().length === 0);

        actions.player.play(first, s().library.local);
        await new Promise((resolve) => setTimeout(resolve, 220));
        actions.player.setProgress(20, 200);
        const snapshot = petPlaybackSnapshot();
        check(
            'pet: 只读快照含曲目 / 播放态 / 歌词行 / 主题',
            snapshot.track?.title === first.title &&
                snapshot.playing &&
                snapshot.duration === 200 &&
                snapshot.lyric !== null &&
                (snapshot.theme === 'light' || snapshot.theme === 'dark'),
            JSON.stringify(snapshot),
        );
        actions.player.stop();
        clearPets();
    }

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

    /* 下载标记（列表里的「已下载 / 下载中」）——用户报「只能在下载页看，业务列表看不出」 */
    {
        const plain = {...s().library.local[5], id: 'no-task-track'};
        check(
            'download-mark: 没有任务时不渲染任何东西（不写「未下载」那种噪声）',
            renderToString(<DownloadMark track={plain}/>) === '',
        );
        const running = renderToString(<DownloadMark track={dlTrack}/>);
        check(
            'download-mark: 有任务时显示下载中与进度',
            running.includes('下载中') && running.includes('data-status="downloading"'),
            running,
        );
    }

    const addedTask = s().download.tasks.find((t) => t.track.id === dlTrack.id)!;
    /* 有空闲并发槽时直接开始（与桌面端一致；满槽才会显示「等待中」） */
    check('store: 新下载任务有空闲槽时直接开始', addedTask.status === 'downloading');
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
    check(
        'skin: 无核心时「导出到文件」返回 null（调用方退回复制 JSON）',
        (await skinService.exportToFile('probe-skin')) === null,
    );
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
    render('DesktopLyricsApp（无窗口时的空态）', <DesktopLyricsApp/>);

    /* ---------------- 窗口控制（无边框窗口的两个真实 bug） ---------------- */
    {
        const titleBarHtml = renderToString(
            <MemoryRouter initialEntries={['/ranking']}>
                <ThemeProvider><TitleBar/></ThemeProvider>
            </MemoryRouter>,
        );
        /* decorations: false 时窗口靠这个属性拖动；丢了它整个窗口就拖不动 */
        check(
            '窗口：标题栏挂载拖动区（无边框窗口可拖动）',
            titleBarHtml.includes('data-tauri-drag-region'),
        );
        /* 已在歌词页时不再 push：否则返回要点 N 次才回得去 */
        check(
            '窗口：播放条在歌词页不再重复压入历史',
            shouldOpenNowPlaying('/now-playing') === false &&
                shouldOpenNowPlaying('/collection/album/mock/album%3Ax') === true,
        );
        /* 最大化 / 向下还原必须是两个可区分的图标与文案 */
        const normalTitle = renderToString(<Toolbar/>);
        const maximizedTitle = renderToString(<Toolbar maximized/>);
        check(
            '窗口：最大化与向下还原使用不同图标 / 文案',
            normalTitle.includes(`title="${i18n.t('toolbar.maximize')}"`) &&
                maximizedTitle.includes(`title="${i18n.t('toolbar.restore')}"`) &&
                !maximizedTitle.includes(`title="${i18n.t('toolbar.maximize')}"`),
        );
        const lyricsTitle = renderToString(<Toolbar desktopLyricsOpen/>);
        check(
            '窗口：桌面歌词按钮有独立入口与按下态',
            lyricsTitle.includes(i18n.t('toolbar.desktopLyrics')),
        );
    }
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
    /* 源收藏：浏览器里没有核心 → 不出现任何源，只给一句说明（不拿演示数据冒充收藏夹） */
    render('SourceFavorites（浏览器模式）', <SourceFavorites/>);
    check(
        'favorites: 非核心源没有源收藏入口（返回 null 而不是空列表）',
        (await catalogService.fetchFavoritesFrom('demo-source')) === null,
    );
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

    /* 第三方授权（浏览器模式）：没有核心 → 状态未知、发起授权直接失败，
       而不是挂在那里等一个永远不来的回调 */
    {
        check('auth: 浏览器下状态为 null（不伪造「已授权」）', (await oauthStatus('smoke-oauth')) === null);
        const begin = await oauthBegin('smoke-oauth');
        check(
            'auth: 浏览器下发起授权如实失败（unsupported_platform）',
            !begin.ok && begin.error.code === 'common.unsupported_platform',
            begin.ok ? '意外成功' : begin.error.code,
        );

        /* 声明了 @oauth 的插件：授权卡片出现；没声明的面板里不该有它 */
        const oauthPlugin = {
            id: 'smoke-oauth',
            name: '授权源',
            version: '1.0.0',
            author: 'test',
            description: 'oauth render',
            builtin: false,
            enabled: true,
            priority: 10,
            compat: false,
            origin: {kind: 'paste' as const},
            manifest: {
                id: 'smoke-oauth',
                name: '授权源',
                version: '1.0.0',
                author: 'test',
                description: 'oauth render',
                qualities: ['standard' as const],
                permissions: [],
                hosts: ['id.example.com'],
                credentials: [],
                oauth: {
                    authorizeUrl: 'https://id.example.com/authorize',
                    tokenUrl: 'https://id.example.com/token',
                    clientId: 'demo',
                    scopes: ['fav'],
                    pkce: true,
                    redirectPort: 0,
                },
                tags: [],
                capabilities: ['search' as const],
            },
        };
        const withOauth = renderToString(<PluginSettings plugin={oauthPlugin}/>);
        const withoutOauth = renderToString(
            <PluginSettings plugin={{...oauthPlugin, manifest: {...oauthPlugin.manifest, oauth: undefined}}}/>,
        );
        check(
            'auth: 声明 @oauth 的插件出现授权入口（含声明的 scope）',
            withOauth.includes('OAuth') && withOauth.includes('fav'),
        );
        check(
            'auth: 没声明 @oauth 的插件不显示授权入口',
            !withoutOauth.includes('OAuth'),
        );
    }

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
        eventNames.length === 9 && eventNames.every((name) => EVENT_NAME_PATTERN.test(name)),
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
    const browserCache = await coreSystem.cacheStatus();
    check(
        'core: 浏览器下缓存状态返回 unsupported_platform（界面据此说明需要桌面端）',
        browserCache.ok === false && browserCache.error.code === 'common.unsupported_platform',
    );
    const browserLyricSearch = await catalogService.searchLyrics('测试');
    check(
        'core: 浏览器下歌词搜索返回空且不抛异常',
        browserLyricSearch.data === null && !browserLyricSearch.error,
    );

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
    /** 核心侧收到的 `download.create` 参数（设置页的目录 / 音质是否真的生效） */
    const downloadCreateCalls: Record<string, unknown>[] = [];
    const fakeDownloadSeed = s().library.local[0] ?? s().collection.favorites[0] ?? s().player.queue[0];
    /* 假宿主里核心会「读失败」，本地曲库因此为空（R28 的策略）——播放类断言要用这里预抓的曲目 */
    const fakeTrackSeeds = [...s().library.local, ...s().collection.favorites, ...s().player.queue];
    /** 记录核心侧收到的推荐类命令，用于断言「按源路由」与「反馈动作」 */
    const recommendCalls: Record<string, unknown>[] = [];
    const feedbackCalls: Record<string, unknown>[] = [];
    const detailCalls: Record<string, unknown>[] = [];
    const lyricsCalls: Record<string, unknown>[] = [];
    const lyricSearchCalls: Record<string, unknown>[] = [];
    const favoritesCalls: Record<string, unknown>[] = [];
    const favoriteCollectionCalls: Record<string, unknown>[] = [];
    const cacheConfigCalls: Record<string, unknown>[] = [];
    const savePlaylistCalls: Record<string, unknown>[] = [];
    const skinExportCalls: Record<string, unknown>[] = [];
    const skinImportCalls: Record<string, unknown>[] = [];
    const cacheClearCalls: Record<string, unknown>[] = [];
    /** `system.reveal` 收到的路径（导出皮肤后要在资源管理器里定位它） */
    const revealCalls: string[] = [];
    const resolveCalls: Record<string, unknown>[] = [];
    const reportCalls: Record<string, unknown>[] = [];
    /** 这些源在假宿主里「解析不到地址」（R71 的停表 / 换源断言用它） */
    let resolveFailFor: string[] = [];
    await withFakeCore(
        (command, params, host) => {
            if (command === 'plugin.list') {
                return envelope([
                    {id: 'core-source', name: '核心音源', version: '9.0.0', enabled: true, builtin: false},
                    {id: 'no-favorites-source', name: '没有收藏夹的源', version: '1.0.0', enabled: true, builtin: false},
                ]);
            }
            if (command === 'playback.resolve') {
                resolveCalls.push(params);
                const source = String((params as {source?: unknown}).source ?? 'local');
                if (resolveFailFor.includes(source)) {
                    return failure('source.unavailable', `探针：${source} 解析不到地址`);
                }
                return envelope({streamUrl: 'http://127.0.0.1:1/probe', source, quality: 'standard'});
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
            if (command === 'catalog.lyricsSearch') {
                lyricSearchCalls.push(params);
                return envelope({
                    items: fakeDownloadSeed
                        ? [
                              {
                                  source: 'core-source',
                                  sourceName: '核心音源',
                                  track: fakeDownloadSeed,
                                  lyrics: {format: 'lrc', content: '[00:01.00]核心给的歌词'},
                              },
                          ]
                        : [],
                    searchedSources: ['core-source'],
                    failedSources: [],
                    skippedSources: ['search-only'],
                    timedOutSources: [],
                });
            }
            if (command === 'catalog.favoriteCollections') {
                favoriteCollectionCalls.push(params);
                // 多收藏夹的源：界面据此显示选择器；只有一份默认收藏的源返回空数组
                if (params.source !== 'core-source') {
                    return envelope({source: params.source, items: []});
                }
                return envelope({
                    source: params.source,
                    items: [
                        {id: 'default', title: '默认收藏夹', count: 12},
                        {id: 'fav-anime', title: '动画收藏夹'},
                    ],
                });
            }
            if (command === 'catalog.favorites') {
                favoritesCalls.push(params);
                // 源收藏：分页形状来自核心（`hasMore` 由插件的 isEnd 决定），出错走真实错误码
                if (params.source === 'no-favorites-source') {
                    return failure('common.not_implemented', '该源没有 getFavorites');
                }
                return envelope({
                    source: params.source,
                    items: fakeDownloadSeed ? [fakeDownloadSeed] : [],
                    hasMore: params.page === undefined || params.page === 1,
                    nextPage: params.page === undefined || params.page === 1 ? 2 : null,
                });
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
                downloadCreateCalls.push(params);
                // `ok:` 开头的曲目走成功路径：用它验证并发排队与设置项是否真的带过去
                const refTrackId = String((params.track as {id?: unknown} | undefined)?.id ?? '');
                if (refTrackId.startsWith('ok:')) {
                    return envelope({
                        id: `dl-ok-${downloadCreateAttempts}`,
                        track: params.track ?? null,
                        status: 'pending',
                        progress: 0,
                        totalMb: 0,
                        sizeText: '',
                    });
                }
                return failure('common.not_found', `插件未安装：${String(params.ref ?? '')}`);
            }
            if (command === 'system.reveal') {
                revealCalls.push(String((params as {path?: unknown}).path ?? ''));
                return envelope(null);
            }
            if (command === 'system.cacheStatus') {
                return envelope({
                    mediaBytes: 2048,
                    mediaCount: 2,
                    catalogBytes: 1024,
                    catalogCount: 3,
                    coversBytes: 512,
                    coversCount: 1,
                    limitBytes: 1024 * 1024 * 1024,
                    limitMinBytes: 128 * 1024 * 1024,
                    limitMaxBytes: 32 * 1024 * 1024 * 1024,
                });
            }
            if (command === 'system.cacheClear') {
                cacheClearCalls.push(params);
                return envelope({removedBytes: 2048, removedFiles: 2});
            }
            if (command === 'system.cacheConfig') {
                cacheConfigCalls.push(params);
                const limitBytes = Number(params.limitBytes ?? 0);
                // 越界：核心会拒（界面据此显示错误，而不是以为设置成功）
                if (limitBytes < 128 * 1024 * 1024) {
                    return failure('common.invalid_argument', '缓存上限太小');
                }
                return envelope({
                    mediaBytes: 1024 * 1024,
                    mediaCount: 2,
                    catalogBytes: 4096,
                    catalogCount: 3,
                    coversBytes: 512,
                    coversCount: 1,
                    limitBytes,
                    limitMinBytes: 128 * 1024 * 1024,
                    limitMaxBytes: 32 * 1024 * 1024 * 1024,
                });
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
                /* 核心**只校验令牌**：`swatches` 这类展示字段可以整块缺失（R68 真机导入
                   一份只有 palette 的皮肤，主题市场在 `swatches.map` 上崩成错误边界）。
                   这里就按核心的真实形状回，逼前端在服务层补齐。 */
                return envelope({
                    id: 'probe-skin',
                    name: '探针皮肤',
                    builtin: false,
                });
            }
            if (command === 'skin.export') {
                skinExportCalls.push(params);
                /* `format:'file'` 时核心写 `<data>/skins/<id>.json` 并回路径（R68 导出按钮走这条） */
                if (params.format === 'file') {
                    return envelope({path: `F:/data/skins/${String(params.id)}.json`});
                }
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

            /* 6c. 导出到**文件**：桌面宿主没有下载处理器，必须用核心的 `format:'file'` 落盘，
               再把路径交给 `system.reveal` 定位（R68 用户报的「导出按钮没反应」） */
            skinExportCalls.length = 0;
            const exportedPath = await skinService.exportToFile('user-skin');
            check(
                'fake: 导出到文件用核心 file 格式并带回落盘路径',
                exportedPath === 'F:/data/skins/user-skin.json' &&
                    skinExportCalls.length === 1 &&
                    skinExportCalls[0].format === 'file' &&
                    skinExportCalls[0].id === 'user-skin',
                JSON.stringify({exportedPath, calls: skinExportCalls}),
            );
            revealCalls.length = 0;
            await coreSystem.reveal(exportedPath ?? '');
            check(
                'fake: 导出后能用 system.reveal 在资源管理器里定位该文件',
                revealCalls.includes('F:/data/skins/user-skin.json'),
                JSON.stringify(revealCalls),
            );

            /* 6d. 缓存管理：状态与清理都走核心；清理后界面会重新读一次状态 */
            const cacheStatus = await coreSystem.cacheStatus();
            check(
                'fake: 缓存状态读核心（媒体/歌词/封面分别统计）',
                cacheStatus.ok &&
                    cacheStatus.data.mediaCount === 2 &&
                    cacheStatus.data.catalogCount === 3 &&
                    cacheStatus.data.coversCount === 1 &&
                    cacheStatus.data.limitBytes > 0,
                JSON.stringify(cacheStatus),
            );
            cacheClearCalls.length = 0;
            const cleared = await coreSystem.cacheClear('media');
            check(
                'fake: 清理缓存指定 kind 并带回删除统计',
                cleared.ok &&
                    cacheClearCalls.length === 1 &&
                    cacheClearCalls[0].kind === 'media' &&
                    cleared.data.removedFiles === 2,
                JSON.stringify({calls: cacheClearCalls, cleared}),
            );

            /* 缓存上限：改它是一条独立命令（读用 cacheStatus、写用 cacheConfig），
               越界必须被核心拒绝——界面据此显示错误，而不是以为设置成功 */
            cacheConfigCalls.length = 0;
            const limited = await coreSystem.cacheConfig(2 * 1024 * 1024 * 1024);
            check(
                'fake: 缓存上限走核心并回带新上限',
                limited.ok &&
                    cacheConfigCalls.length === 1 &&
                    cacheConfigCalls[0].limitBytes === 2 * 1024 * 1024 * 1024 &&
                    limited.data.limitBytes === 2 * 1024 * 1024 * 1024,
                JSON.stringify({calls: cacheConfigCalls, limited}),
            );
            const rejected = await coreSystem.cacheConfig(1024);
            check(
                'fake: 越界的缓存上限被核心拒绝（不静默改设置）',
                !rejected.ok && rejected.error.code === 'common.invalid_argument',
                JSON.stringify(rejected),
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
            check(
                'fake: 核心回来的皮肤缺展示字段时在服务层补齐（缺 swatches 会崩掉主题市场）',
                Array.isArray(byText.skin?.swatches) &&
                    byText.skin?.swatches.length === 0 &&
                    byText.skin?.description === '' &&
                    byText.skin?.author === 'imported',
                JSON.stringify(byText.skin),
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

            /* 7b. 下载设置真的生效：目录 / 默认音质 / 缺档策略直接进 `download.create`；
               并发上限用「排队占位」实现——第一首没结束时第二首不建任务。 */
            if (fakeTrackSeeds[0]) {
                const base = fakeTrackSeeds[0];
                const makeQueuedTrack = (suffix: string, qualities: TrackQuality[]): Track => {
                    const track = {
                        ...base,
                        id: `ok:${suffix}`,
                        source: 'ok-source',
                        title: `队列曲目 ${suffix}`,
                    };
                    return {
                        ...track,
                        candidates: [{source: 'ok-source', track, qualities}],
                    };
                };

                actions.ui.setDownloadDir('C:\\Downloads\\gently');
                actions.ui.setDownloadQuality('hires');
                actions.ui.setDownloadQualityFallback('lower');
                actions.ui.setDownloadMaxConcurrent(1);

                downloadCreateAttempts = 0;
                downloadCreateCalls.length = 0;

                const queuedA = makeQueuedTrack('a', ['standard', 'high']);
                const queuedB = makeQueuedTrack('b', ['standard', 'high']);
                actions.download.add(queuedA);
                await flushIpc();
                actions.download.add(queuedB);
                await flushIpc();

                const firstCall = downloadCreateCalls[0];
                check(
                    'fake: 下载目录与缺档策略真的进了 download.create',
                    firstCall?.dir === 'C:\\Downloads\\gently' && firstCall?.quality === 'high',
                    JSON.stringify({dir: firstCall?.dir, quality: firstCall?.quality}),
                );
                check(
                    'fake: 并发上限生效（第二首只排队、不超发）',
                    downloadCreateAttempts === 1 &&
                        s().download.tasks.some(
                            (task) => task.track.id === queuedB.id && task.status === 'pending',
                        ),
                    `attempts=${downloadCreateAttempts}`,
                );

                const firstTask = s().download.tasks.find((task) => task.track.id === queuedA.id);
                if (firstTask) {
                    host.emit('download:done', {id: firstTask.id, path: 'C:/tmp/a.mp3', bytes: 1024});
                    await flushIpc();
                    check(
                        'fake: 前一首完成后排队的下一首自动开始',
                        downloadCreateAttempts === 2 &&
                            s().download.tasks.some(
                                (task) =>
                                    task.track.id === queuedB.id && task.id.startsWith('dl-ok-'),
                            ),
                        `attempts=${downloadCreateAttempts}`,
                    );
                }

                // 收尾：恢复默认设置，避免影响后面的断言
                actions.ui.setDownloadDir('');
                actions.ui.setDownloadQuality('high');
                actions.ui.setDownloadQualityFallback('lower');
                actions.ui.setDownloadMaxConcurrent(3);
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

                /* 歌词搜索：走核心命令，结果带回来源名称与条目信息（用户据此挑一份） */
                lyricSearchCalls.length = 0;
                const outcome = await catalogService.searchLyrics('测试歌词');
                check(
                    'fake: 歌词搜索走核心并带回来源与候选曲目',
                    lyricSearchCalls.length === 1 &&
                        lyricSearchCalls[0].query === '测试歌词' &&
                        outcome.data?.items.length === 1 &&
                        outcome.data.items[0].sourceName === '核心音源' &&
                        outcome.data.items[0].track.id === fakeDownloadSeed?.id,
                    JSON.stringify({calls: lyricSearchCalls, outcome}),
                );

                /* 源收藏：核心命令 `catalog.favorites` + 分页形状 + 「该源没有收藏夹」的错误码 */
                favoritesCalls.length = 0;
                const firstPage = await catalogService.fetchFavoritesFrom('core-source');
                check(
                    'fake: 源收藏走核心并带回分页信息',
                    favoritesCalls.length === 1 &&
                        favoritesCalls[0].source === 'core-source' &&
                        firstPage?.items.length === 1 &&
                        firstPage.hasMore === true &&
                        firstPage.nextPage === 2,
                    JSON.stringify({calls: favoritesCalls, firstPage}),
                );

                const secondPage = await catalogService.fetchFavoritesFrom('core-source', 2);
                check(
                    'fake: 源收藏翻页把页码交给核心，且末页没有下一页',
                    favoritesCalls.length === 2 &&
                        favoritesCalls[1].page === 2 &&
                        secondPage?.hasMore === false &&
                        secondPage.nextPage === null,
                    JSON.stringify({calls: favoritesCalls, secondPage}),
                );

                const noCapability = await catalogService.fetchFavoritesFrom('no-favorites-source');
                check(
                    'fake: 源不支持收藏夹时如实带出 not_implemented（不是空列表）',
                    noCapability?.error?.code === 'common.not_implemented' && noCapability.items.length === 0,
                    JSON.stringify(noCapability),
                );

                /* 收藏夹选择（「不同第三方不同策略」）：先列出来，选中后把 id 交给核心 */
                favoriteCollectionCalls.length = 0;
                const collectionList = await catalogService.fetchFavoriteCollections('core-source');
                check(
                    'fake: 源的可选收藏夹来自核心（含数量）',
                    favoriteCollectionCalls.length === 1 &&
                        collectionList.length === 2 &&
                        collectionList[0].id === 'default' &&
                        collectionList[0].count === 12,
                    JSON.stringify({calls: favoriteCollectionCalls, collectionList}),
                );

                favoritesCalls.length = 0;
                const scopedPage = await catalogService.fetchFavoritesFrom('core-source', 1, 'fav-anime');
                check(
                    'fake: 选中收藏夹时把 collectionId 交给核心',
                    favoritesCalls.length === 1 &&
                        favoritesCalls[0].collectionId === 'fav-anime' &&
                        scopedPage?.items.length === 1,
                    JSON.stringify({calls: favoritesCalls, scopedPage}),
                );

                const noCollections = await catalogService.fetchFavoriteCollections('no-favorites-source');
                check(
                    'fake: 只有一份默认收藏的源返回空收藏夹列表（不报错）',
                    noCollections.length === 0,
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

            /* 16b. 「界面在播、实际没声音」：解析全失败必须**停表并给出原因**，不能假装在播。
               以前失败只把 `playable` 置 false，`playing` 还是 true、回退时钟继续走进度——
               用户看到的是「播放中」却完全无声，也没有任何提示。 */
            {
                const probeTrack = {
                    id: 'local:71',
                    source: 'local',
                    title: '两个源的探针曲目',
                    artist: '探针',
                    album: '',
                    durationSec: 120,
                };
                /* 两个候选源都必须是「核心认识」的：`local` 是核心伪源，`core-source` 来自 plugin.list */
                const grouped = {
                    ...probeTrack,
                    candidates: [
                        {source: 'local', track: {...probeTrack}, qualities: ['standard']},
                        {source: 'core-source', track: {...probeTrack, source: 'core-source'}, qualities: ['standard']},
                    ],
                } as unknown as Track;

                /* 两个源都解析不到 → 停播 + 说明原因 */
                resolveFailFor = ['local', 'core-source'];
                actions.player.play(grouped, [grouped]);
                await new Promise((resolve) => setTimeout(resolve, 80));
                check(
                    'store: 所有音源都解析不到时停表并给出原因（不再假装在播）',
                    s().player.playing === false &&
                        s().player.playbackError?.kind === 'noSource' &&
                        s().player.playbackError?.failedSources.length === 2,
                    JSON.stringify({playing: s().player.playing, err: s().player.playbackError}),
                );

                /* 原地重试：只剩一个源能放 → 应该自动用它继续播，且清掉失败标记 */
                resolveFailFor = ['core-source'];
                actions.player.retryPlayback();
                await new Promise((resolve) => setTimeout(resolve, 80));
                check(
                    'store: 重试播放会重新解析并用还能放的源继续',
                    s().player.playing === true &&
                        s().player.activeSource === 'local' &&
                        s().player.playbackError === null,
                    JSON.stringify({playing: s().player.playing, source: s().player.activeSource, err: s().player.playbackError}),
                );

                /* 播放中媒体元素报错：先换源——另一个源还能放就继续，不许变成「静音播放」 */
                resolveFailFor = ['local', 'core-source'];
                actions.player.markUnplayable('code 4');
                await new Promise((resolve) => setTimeout(resolve, 80));
                check(
                    'store: 媒体报错时全部候选都试过才停播（并带上错误说明）',
                    s().player.playing === false &&
                        s().player.playbackError?.kind === 'media' &&
                        s().player.playbackError?.detail === 'code 4',
                    JSON.stringify({playing: s().player.playing, err: s().player.playbackError}),
                );

                resolveFailFor = [];
                actions.player.retryPlayback();
                await new Promise((resolve) => setTimeout(resolve, 80));
                check(
                    'store: 重试成功后失败提示消失',
                    s().player.playing === true && s().player.playbackError === null,
                    JSON.stringify({playing: s().player.playing, err: s().player.playbackError}),
                );
                actions.player.stop();
            }

            /* 播放失败时播放条要**说出来**：一个「无法播放 · 重试」的按钮，点它重新解析 */
            {
                const failTrack = {
                    id: 'local:72',
                    source: 'local',
                    title: '播不出来的曲目',
                    artist: '探针',
                    album: '',
                    durationSec: 60,
                } as unknown as Track;
                resolveFailFor = ['local'];
                actions.player.play(failTrack, [failTrack]);
                await new Promise((resolve) => setTimeout(resolve, 80));
                const barHtml = renderToString(
                    <MemoryRouter>
                        <ThemeProvider>
                            <PlayerBar/>
                        </ThemeProvider>
                    </MemoryRouter>,
                );
                check(
                    'player-bar: 播放失败时显示「无法播放」与「重试」',
                    barHtml.includes(i18n.getFixedT('zh')('player.playbackFailed')) &&
                        barHtml.includes(i18n.getFixedT('zh')('player.retry')) &&
                        barHtml.includes(i18n.getFixedT('zh')('player.failureNoSource', {count: 1})),
                    barHtml.slice(0, 200),
                );
                actions.player.stop();
                resolveFailFor = [];
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

    /* 第三方授权（假宿主 = 桌面端分支）：命令名与参数对不对、授权地址是否真的交给
       系统浏览器、取消是否收尾、事件能否刷新界面。 */
    {
        const calls: {command: string; params: Record<string, unknown>}[] = [];
        const opened: string[] = [];
        const STATUS = {
            pluginId: 'auth-source',
            declared: true,
            authorized: false,
            expiresAt: null,
            scopes: [],
            declaredScopes: ['fav'],
            pending: false,
            backend: 'windows-credential-manager',
        };
        await withFakeCore(
            (command, params) => {
                calls.push({command, params});
                if (command === 'plugin:opener|open_url') {
                    opened.push(String((params as {url?: string}).url ?? ''));
                    return envelope(null);
                }
                switch (command) {
                    case 'auth.status':
                        return envelope(STATUS);
                    case 'auth.begin':
                        return envelope({
                            pluginId: 'auth-source',
                            authorizeUrl:
                                'https://id.example.com/authorize?response_type=code&client_id=demo&code_challenge_method=S256',
                            redirectUri: 'http://127.0.0.1:51234/callback',
                            state: 'a'.repeat(32),
                            expiresAt: Date.now() + 180_000,
                        });
                    case 'auth.cancel':
                    case 'auth.signOut':
                        return envelope(null);
                    default:
                        return failure('common.not_found', `未预置：${command}`);
                }
            },
            async (host) => {
                const status = await oauthStatus('auth-source');
                check(
                    'fake: 授权状态走核心（已声明 + 未授权 + 凭据库落点）',
                    status?.declared === true &&
                        status.authorized === false &&
                        status.backend === 'windows-credential-manager' &&
                        calls.some((call) => call.command === 'auth.status' && call.params.pluginId === 'auth-source'),
                    JSON.stringify(status),
                );

                const begin = await oauthBegin('auth-source');
                check(
                    'fake: 发起授权把插件声明的地址交给系统浏览器',
                    begin.ok &&
                        opened.length === 1 &&
                        opened[0].startsWith('https://id.example.com/authorize') &&
                        calls.some((call) => call.command === 'auth.begin'),
                    begin.ok ? `opened=${opened.join(',')}` : begin.error.code,
                );

                const cancelled = await oauthCancel('auth-source');
                check(
                    'fake: 取消授权走核心',
                    cancelled.ok && calls.some((call) => call.command === 'auth.cancel'),
                );

                const signedOut = await oauthSignOut('auth-source');
                check(
                    'fake: 退出登录走核心',
                    signedOut.ok && calls.some((call) => call.command === 'auth.signOut'),
                );

                // 事件链路：回调线程换到令牌 → 界面应收到 `auth:changed`
                let received: {pluginId: string; authorized: boolean} | null = null;
                const unlisten = await oauthListen((payload) => {
                    received = payload;
                });
                host.emit('auth:changed', {pluginId: 'auth-source', authorized: true, expiresAt: 1_800_000_000_000});
                await new Promise((resolve) => setTimeout(resolve, 20));
                unlisten();
                check(
                    'fake: auth:changed 事件能刷新授权状态',
                    received !== null && (received as {authorized: boolean}).authorized === true,
                    JSON.stringify(received),
                );
            },
        );
    }

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
