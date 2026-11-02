import {
    demoSourcesEnabled,
    getActiveMusicSource,
    getMusicSource,
    getMusicSourceQualities,
    listEnabledMusicSources,
    listMusicSourceInfos,
    registerMusicSource,
    setMusicSourceEnabled,
    unregisterMusicSource,
} from '../plugins';
import type {
    CoreError,
    LoginQrSession,
    LoginQrStatus,
    LyricSearchResult,
    TopListGroup,
    TopListPage,
    UpstreamVerdict,
    WebLoginPlan,
    WebLoginResult,
} from '../api';
import {findAlbum, findCuratedPlaylist} from '../mock/catalog.mock';
import type {
    Album,
    CuratedPlaylist,
    GroupedTrack,
    PluginInfo,
    ResolvedSource,
    Track,
    TrackQuality,
} from '../types';
import type {MusicSourcePlugin} from '../plugins';
import type {CoreFavoriteCollection} from './core.catalog';
import {coreAvailable, coreWebLogin} from './core.bridge';
import {
    coreAlbum,
    coreDiagnoseUpstream,
    coreFavoriteCollections,
    coreFavorites,
    coreLyricsSearch,
    coreLoginQr,
    coreLoginQrPoll,
    coreLoginWeb,
    corePlaylist,
    coreRecommend,
    coreResolveUrl,
    coreSearch,
    coreTopList,
    coreTopLists,
    coreTrackDetail,
} from './core.catalog';
import {coreSourceIds, coreSourceQualities, ensureCoreSources, isCorePlayableSource, isCoreSource} from './core.sources';
import {groupTracks, sortCandidates} from '../utils/track';

/**
 * 在线曲库门面。
 *
 * 多音源策略：
 * - **聚合（aggregate）**：向所有已启用音源发起请求，按 (标题, 歌手) 合并成
 *   「一首歌一条」，多个音源作为候选挂在 `candidates` 上 —— 避免同一首歌重复出现；
 * - **分源（perSource）**：只请求指定音源，返回原始条目（不做合并）；
 * - 播放时按候选顺序调用 `resolveUrl`，`null` 表示该源不可播，由播放器自动切换到下一个。
 *
 * 榜单/分类是**按源**的（跨源的分类树无法合并），因此不参与聚合：`all` 表示
 * 「让应用挑一个优先级最高的源」。
 *
 * **按源路由**（`core.sources`）：核心认识的源走本机核心，只活在前端注册表里的
 * 内置演示源走本地实现。判定必须按**源**做，不能按「有没有核心」做——桌面上装了
 * 插件时核心认识 A 源、不认识内置演示源，两者要同时可用。
 */

export const catalogService = {
    /* ---------------- 音源元数据 ---------------- */

    /** 已安装音源（含 enabled 状态），供页面筛选与插件管理复用 */
    listSources(): PluginInfo[] {
        return listMusicSourceInfos();
    },

    /** 已实现且已启用的音源：参与聚合与自动回退的集合 */
    listActiveSources(): PluginInfo[] {
        return listEnabledMusicSources().map((plugin) => ({...plugin.info, enabled: true}));
    },

    /**
     * 当前生效的音源；**一个可用音源都没有时返回 `null`**。
     *
     * `sources` 传「已安装音源清单」（界面的插件列表，桌面端来自核心）时优先看它：
     * 前端注册表在桌面上是**空的**（内置演示源只在浏览器预览里注册），
     * 只读注册表会让设置页在核心明明有音源时显示「还没有安装任何插件」。
     * 缺省退回注册表（浏览器预览，或调用方手上没有清单）。
     *
     * 给界面用：视图不得直接依赖 `src/plugins`（AGENTS 第 5 条），而且桌面上
     * 「还没装音源」是正常状态——返回 `null` 让视图渲染空态，而不是在渲染期
     * 撞上一个抛出的异常（应用没有错误边界，那会整页白屏）。
     */
    activeSource(sources?: PluginInfo[]): PluginInfo | null {
        if (sources) return sources.find((plugin) => plugin.enabled) ?? sources[0] ?? null;
        return getActiveMusicSource()?.info ?? null;
    },

    setSourceEnabled(id: string, enabled: boolean): void {
        setMusicSourceEnabled(id, enabled);
    },

    /** 卸载音源（内置源由调用方拦截） */
    unregisterSource(id: string): void {
        unregisterMusicSource(id);
    },

    sourceQualities(id: string): readonly TrackQuality[] {
        // 浏览器演示源在前端注册表；桌面插件只在核心清单里（注册表为空）。
        // 两边都查：否则核心源的候选音质会被当成空数组，播放/下载只能盲试首选档位。
        const local = getMusicSourceQualities(id);
        return local.length > 0 ? local : coreSourceQualities(id);
    },

    /** 注册一个音源（真实插件接入时使用） */
    registerSource(plugin: Parameters<typeof registerMusicSource>[0]): void {
        registerMusicSource(plugin);
    },

    /* ---------------- 榜单 / 分类（按源渲染，结构由源决定） ---------------- */

    /**
     * 某个源的榜单/分类树。
     *
     * **路由按源判定**（`core.sources`）：核心认识的源走本机核心（`catalog.topLists`），
     * 只活在前端注册表里的**内置演示源**走本地实现。
     *
     * 这里**不能**先无脑问核心、错了再退回 mock：核心对不认识的源只会回
     * `common.not_found`（`插件未安装：mock`），而 `not_found` 与「源跑挂了」在
     * 前端看来是同一类失败——结果就是「核心里一个音源都没装」这种正常状态
     * 被显示成一条故障提示，连演示数据都看不到。
     *
     * **核心报错时不悄悄退回 mock**：那会把「源跑挂了」伪装成「这个源没有分类」，
     * 用户看到的空列表与真实原因完全无关（实测踩到过：插件报 404，界面只显示空态）。
     * 因此把原始错误一并交出去，由界面如实说明。
     */
    async fetchTopLists(sourceId?: string): Promise<{groups: TopListGroup[]; error?: CoreError}> {
        await ensureCoreSources();
        const id: string | null = sourceId && sourceId !== 'all' ? sourceId : this.defaultSourceId();
        // 一个源都没有：如实返回空（界面显示「还没有安装任何音源」），不是故障
        if (!id) return {groups: []};

        if (isCoreSource(id)) {
            /* 用对象持有错误：`let` 变量在闭包里被赋值时 TS 的收窄会把它当成 `null` */
            const seen: {failure?: CoreError} = {};
            const viaCore = await coreTopLists(id, (error) => {
                seen.failure = error;
            });
            if (viaCore) return {groups: viaCore};
            // 核心说「这个源不存在」= 它属于前端演示源那条路（路由表可能刚过期），不是故障
            const failure = seen.failure;
            if (failure && failure.code !== 'common.not_found') return {groups: [], error: failure};
        }

        const plugin = getMusicSource(id);
        if (!plugin) return {groups: []};
        return {groups: await plugin.fetchTopLists()};
    },

    /** 某个分类的一页内容（分页由源决定：`hasMore` / `nextPage`）。错误语义同上。 */
    async fetchTopList(
        sourceId: string,
        itemId: string,
        page = 1,
    ): Promise<{page: TopListPage; error?: CoreError}> {
        await ensureCoreSources();
        if (isCoreSource(sourceId)) {
            const seen: {failure?: CoreError} = {};
            const viaCore = await coreTopList(sourceId, itemId, page, (error) => {
                seen.failure = error;
            });
            if (viaCore) return {page: viaCore};
            const failure = seen.failure;
            if (failure && failure.code !== 'common.not_found') {
                return {page: {items: [], hasMore: false}, error: failure};
            }
        }

        const plugin = getMusicSource(sourceId);
        if (!plugin) return {page: {items: [], hasMore: false}};
        return {page: await plugin.fetchTopList(itemId, page)};
    },

    /**
     * 聚合模式下「用哪个源」：优先级最高的已启用源；**一个都没有时返回 `null`**。
     *
     * 榜单是**按源**提供的，聚合没有意义（跨源的分类树无法合并），
     * 因此 `all` 只是「让应用替我挑一个源」，而不是真的聚合。
     *
     * 桌面端优先挑**核心认识的源**：内置演示源是兜底，不该盖过核心里真实装好的音源。
     *
     * **不再抛异常**：注册表为空（桌面上一个音源都没装）是正常状态，
     * 以前这里 `getActiveMusicSource()` 会抛，把「还没装音源」变成一条被拒的 Promise，
     * 调用方只能看到一个没有理由的空列表。返回 `null` 由调用方给诚实的空态。
     */
    defaultSourceId(): string | null {
        const coreId = coreSourceIds(true)[0];
        if (coreId) return coreId;
        return getActiveMusicSource()?.info.id ?? null;
    },

    /* ---------------- 专辑 / 歌单详情 ---------------- */

    /**
     * 专辑详情（`catalog.album`）。
     *
     * 核心认识的源由核心调插件的 `getAlbumInfo`；**核心不认识的源（内置演示源）
     * 不问核心**——核心只会回 `common.not_found`，白跑一趟还污染日志——
     * 直接退回浏览器预览的 mock。两条路径返回同一形状 `Album`（含 `tracks`），视图不分支。
     *
     * mock 只在 `!coreAvailable()`（浏览器预览）时兜底：桌面上核心查不到就是**没有**，
     * 拿演示专辑顶上等于把别人的假数据当成用户点开的内容。
     */
    async fetchAlbum(source: string, id: string): Promise<Album | null> {
        await ensureCoreSources();
        if (isCoreSource(source)) {
            const viaCore = await coreAlbum(source, id);
            if (viaCore) return viaCore;
        }
        if (coreAvailable()) return null;
        return findAlbum(id);
    },

    /** 歌单（源侧精选）详情（`catalog.playlist`），与专辑同构。 */
    async fetchCuratedPlaylist(source: string, id: string): Promise<CuratedPlaylist | null> {
        await ensureCoreSources();
        if (isCoreSource(source)) {
            const viaCore = await corePlaylist(source, id);
            if (viaCore) return viaCore;
        }
        if (coreAvailable()) return null;
        return findCuratedPlaylist(id);
    },

    /* ---------------- 推荐 / 搜索 ---------------- */

    /**
     * 曲目详情（`catalog.track`）：当前曲目由**插件**补充的元数据（封面、专辑、时长、候选）。
     *
     * 用途：列表里的曲目快照可能缺封面/专辑（搜索结果往往只有标题歌手），
     * 播放时问一次源，把封面补上——播放条与歌词页因此能显示真实封面，而不是哈希渐变。
     *
     * 与详情页同一套**按源路由**：核心认识的源走核心；内置演示源没有详情端点，直接返回 `null`
     * （调用方继续用快照，不算失败）。
     */
    async fetchTrackDetail(track: Track): Promise<Track | null> {
        await ensureCoreSources();
        if (!isCoreSource(track.source)) return null;
        const viaCore = await coreTrackDetail(this.trackRef(track.source, track));
        if (!viaCore) return null;
        /* 详情来自单源，但核心返回的是 `GroupedTrack`（含候选）；调用方只要曲目本身 */
        return viaCore;
    },

    /**
     * 单源推荐（源侧 `getRecommend`）。
     *
     * 与 `searchIn` 同一套**按源路由**：核心认识的源走 `catalog.recommend`，
     * 内置演示源走前端实现。核心的源绝不能静默退回演示源——否则「某个源的推荐」
     * 会变成「演示数据」，用户以为看到了 A 源的内容。
     *
     * `limit` 只对**本地**实现有意义（核心的 `catalog.recommend{source}` 没有条数参数，
     * 由插件自己决定给多少）；这里统一切到 `limit`，让界面拿到稳定的「前 N 条」。
     */
    async fetchRecommendFrom(limit: number, sourceId?: string): Promise<Track[]> {
        await ensureCoreSources();
        const id: string | null = sourceId ?? this.defaultSourceId();
        // 一个源都没有：没有可推荐的东西，如实返回空
        if (!id) return [];
        if (isCoreSource(id)) {
            const viaCore = await coreRecommend(id);
            return (viaCore ?? []).slice(0, limit);
        }
        const plugin = getMusicSource(id);
        if (!plugin) return [];
        return plugin.fetchRecommend(limit);
    },

    /**
     * 源侧可选的收藏夹/歌单（`catalog.favoriteCollections`）。
     *
     * 空数组 = 该源只有一份默认收藏（或没有这个能力）——界面据此隐藏选择器，不报错。
     */
    async fetchFavoriteCollections(sourceId: string): Promise<CoreFavoriteCollection[]> {
        if (!isCoreSource(sourceId)) return [];
        const result = await coreFavoriteCollections(sourceId);
        if (result.error) {
            console.warn('[catalog] 读取收藏夹列表失败', result.error.code);
            return [];
        }
        return result.items;
    },

    /**
     * 源侧「我收藏的歌曲」（`catalog.favorites`）。
     *
     * 只对**核心认识的源**有意义：`hasFavorites` 是插件运行时探测出的能力，浏览器预览里
     * 的演示源没有这个概念，因此这里不退回任何 mock——`null` 就是「这个源没有收藏夹入口」。
     */
    async fetchFavoritesFrom(
        sourceId: string,
        page = 1,
        collectionId?: string,
    ): Promise<{
        items: Track[];
        hasMore: boolean;
        nextPage?: number | null;
        error?: CoreError;
    } | null> {
        if (!isCoreSource(sourceId)) return null;
        const result = await coreFavorites(sourceId, page, collectionId);
        if (!result.page) return {items: [], hasMore: false, ...(result.error ? {error: result.error} : {})};
        return {
            items: result.page.items,
            hasMore: result.page.hasMore,
            nextPage: result.page.nextPage ?? null,
        };
    },

    /**
     * 单源搜索。
     *
     * 核心认识的源**必须**走核心：前端注册表里没有它的实现，不判定就会静默退回
     * 内置演示源——用户以为在搜 A 源，拿到的其实是演示数据（比报错更糟）。
     *
     * 没有可用的源 id（桌面上一个音源都没装）时返回**空**：以前这里退回
     * `getActiveMusicSource()`，注册表为空就会抛，把「还没装音源」变成一条被拒的 Promise；
     * 就算注册表里有演示源，拿它顶替用户在搜的源同样是冒充。
     */
    async searchIn(keyword: string, sourceId?: string): Promise<Track[]> {
        await ensureCoreSources();
        if (sourceId && isCoreSource(sourceId)) {
            const viaCore = await coreSearch(keyword, {sources: [sourceId]});
            // 单源搜索没有跨源合并可言：核心结果里每条只有一个候选，取候选里的曲目即原始条目
            return viaCore ? viaCore.items.flatMap((item) => item.candidates.map((candidate) => candidate.track)) : [];
        }
        const plugin = sourceId ? getMusicSource(sourceId) : getActiveMusicSource();
        if (!plugin) return [];
        return plugin.search(keyword);
    },

    /**
     * 搜索建议：默认只问一个源（优先用户指定/正在播的源），别把每个按键放大成全源搜索。
     *
     * 桌面端前端注册表是空的（真实插件在核心里），`searchIn(keyword)` 不带 source
     * 会找不到任何实现，搜索建议因此永远是“没有结果”。这里优先走核心的指定源
     * （或第一个启用源）；没有核心时才退回浏览器演示源。
     */
    async suggest(keyword: string, sourceId?: string, limit = 8): Promise<Track[]> {
        const needle = keyword.trim();
        if (!needle) return [];

        await ensureCoreSources();
        const coreIds = coreSourceIds(true);
        if (coreIds.length > 0) {
            const target = sourceId && coreIds.includes(sourceId) ? sourceId : coreIds[0];
            const viaCore = await coreSearch(needle, {sources: [target], limit: 12});
            if (!viaCore) return [];
            return viaCore.items
                .flatMap((item) => item.candidates.map((candidate) => candidate.track))
                .slice(0, limit);
        }

        const plugin = sourceId ? getMusicSource(sourceId) : getActiveMusicSource();
        if (!plugin) return [];
        return (await plugin.search(needle)).slice(0, limit);
    },

    /** 多源推荐 → 聚合去重 */
    async fetchRecommendAll(limit: number): Promise<GroupedTrack[]> {
        return this.aggregate((plugin) => plugin.fetchRecommend(limit));
    },

    /**
     * 多源搜索 → 聚合去重。
     *
     * **两类源并行跑**（`core.sources` 判定）：
     * - 核心认识的源 → 一次 `catalog.search`（核心并发请求各源、逐源推事件、核心内合并）；
     * - 内置演示源 → 前端本地实现（核心不认识它）。
     *
     * 核心里**一个可用音源都没有**时不再问核心（那只会等出一个空结果，把
     * 「还没装音源」变成「搜不到任何东西」），直接用本地演示源撑住界面；
     * 装好插件后下一次搜索就自动以核心为准。
     *
     * **演示源只在浏览器预览里存在**（`demoSourcesEnabled`，见 `src/plugins/index.ts`）：
     * 桌面端即使核心里一个源都没装，本地这一路也必须是空的——拿演示数据顶上去，
     * 用户看到的就是「搜到了歌，点开却播不了」的假结果。
     *
     * 两类都有结果时，用**前端这一份** `groupTracks` 做跨类合并：否则同一首
     * (标题, 歌手) 会在「核心结果」和「演示结果」里各占一条。核心那份合并只
     * 覆盖核心自己的源，两者不重叠、也不冲突。
     *
     * `signal` 透传给核心：用户换关键词时中止上一轮，避免后台继续打各源。
     */
    async searchAll(keyword: string, signal?: AbortSignal): Promise<GroupedTrack[]> {
        if (!keyword.trim()) return [];
        await ensureCoreSources();

        const coreIds = coreSourceIds(true);
        const localSources =
            demoSourcesEnabled && !coreAvailable()
                ? listEnabledMusicSources().filter((plugin) => !isCoreSource(plugin.info.id))
                : [];

        const [viaCore, localTracks] = await Promise.all([
            coreIds.length > 0
                ? coreSearch(keyword, {sources: coreIds, ...(signal ? {signal} : {})})
                : Promise.resolve(null),
            this.searchLocal(localSources, keyword),
        ]);

        if (!viaCore) return groupTracks(localTracks, (source) => this.sourceQualities(source));

        const coreTracks = viaCore.items.flatMap((item) => item.candidates.map((candidate) => candidate.track));
        if (coreTracks.length === 0 || localTracks.length === 0) return viaCore.items;
        return groupTracks(
            [...coreTracks, ...localTracks],
            (source) => this.sourceQualities(source),
        );
    },

    /** 在给定的本地源里并发搜索并摊平结果；单源失败不影响其他源。 */
    async searchLocal(sources: ReturnType<typeof listEnabledMusicSources>, keyword: string): Promise<Track[]> {
        if (sources.length === 0) return [];
        const settled = await Promise.allSettled(sources.map((plugin) => plugin.search(keyword)));
        const tracks: Track[] = [];
        settled.forEach((result, index) => {
            if (result.status === 'fulfilled') tracks.push(...result.value);
            else console.warn(`[catalog] 音源 ${sources[index].info.id} 搜索失败`, result.reason);
        });
        return tracks;
    },

    /**
     * 并发请求所有已启用音源并按用户偏好排序候选。
     * 单个音源失败不影响整体（`Promise.allSettled`）。
     */
    async aggregate(fetchOne: (plugin: MusicSourcePlugin) => Promise<Track[]>): Promise<GroupedTrack[]> {
        const sources = listEnabledMusicSources();
        if (sources.length === 0) return [];

        const settled = await Promise.allSettled(sources.map((plugin) => fetchOne(plugin)));

        const merged: Track[] = [];
        settled.forEach((result, index) => {
            if (result.status === 'fulfilled') merged.push(...result.value);
            else console.warn(`[catalog] 音源 ${sources[index].info.id} 请求失败`, result.reason);
        });

        return groupTracks(merged, (source) => this.sourceQualities(source));
    },

    /** 按用户音源偏好给候选排序（`preferredSource` 为空表示按注册顺序） */
    orderCandidates(track: GroupedTrack, preferredSource?: string | null): GroupedTrack {
        if (!preferredSource) return track;
        return {...track, candidates: sortCandidates(track.candidates, [preferredSource])};
    },

    /* ---------------- 二维码登录 ---------------- */

    /**
     * 开一次二维码登录会话（`catalog.loginQr`）。
     *
     * 二维码内容由**插件**给（登录 URL 是具体第三方的，核心不掺和）；界面只负责画出来。
     * 用户确认后由核心把会话写进凭据库，**前端永远拿不到令牌**。
     */
    async loginQr(sourceId: string): Promise<{data: LoginQrSession | null; error?: CoreError}> {
        if (!coreAvailable()) return {data: null};
        const result = await coreLoginQr(sourceId);
        if (result.ok && result.data) return {data: result.data};
        return {data: null, ...(result.ok ? {} : {error: result.error})};
    },

    /** 问一次登录状态（`catalog.loginQrPoll`） */
    async loginQrPoll(sourceId: string, key: string): Promise<{data: LoginQrStatus | null; error?: CoreError}> {
        if (!coreAvailable()) return {data: null};
        const result = await coreLoginQrPoll(sourceId, key);
        if (result.ok && result.data) return {data: result.data};
        return {data: null, ...(result.ok ? {} : {error: result.error})};
    },

    /**
     * 用**浏览器窗口**登录（`catalog.loginWeb` + 宿主命令 `web_login`）。
     *
     * 与二维码登录的区别：这里打开的是源站自己的登录页（用户面对站点原有流程），
     * 登录完成后由宿主从 webview 的 Cookie 罐里取出会话；会话值**不经过前端**。
     */
    async loginWebPlan(sourceId: string): Promise<{data: WebLoginPlan | null; error?: CoreError}> {
        if (!coreAvailable()) return {data: null};
        const result = await coreLoginWeb(sourceId);
        if (result.ok && result.data) return {data: result.data};
        return {data: null, ...(result.ok ? {} : {error: result.error})};
    },

    /** 开登录窗口并等用户登录；`state` 只有 confirmed / canceled（超时也算 canceled） */
    async loginWeb(sourceId: string): Promise<{data: WebLoginResult | null; error?: CoreError}> {
        if (!coreAvailable()) return {data: null};
        const result = await coreWebLogin(sourceId);
        if (result.ok && result.data) return {data: result.data};
        return {data: null, ...(result.ok ? {} : {error: result.error})};
    },
    /* ---------------- 歌词搜索 ---------------- */

    /**
     * 跨源按关键词找歌词（`catalog.lyricsSearch`）。
     *
     * - `data === null` 且没有 `error`：浏览器预览（没有核心）——界面如实说明需要桌面端；
     * - `data === null` 且有 `error`：核心拒绝/失败（例如一个源都没装）；
     * - 搜索本身是**用户动作**，因此只在用户点「搜索」时发起，不做预取。
     */
    async searchLyrics(query: string): Promise<{data: LyricSearchResult | null; error?: CoreError}> {
        const keyword = query.trim();
        if (!keyword) return {data: null};
        if (!coreAvailable()) return {data: null};

        const result = await coreLyricsSearch(keyword);
        if (result.ok) return {data: result.data};
        return {data: null, error: result.error};
    },

    /* ---------------- 播放地址 ---------------- */

    /**
     * 解析可播放地址；返回 null 表示该曲目在该音源不可播。
     * 自动回退由播放器按候选顺序调用本方法完成。
     */
    async resolveUrl(
        track: Track,
        quality: TrackQuality,
        sourceId?: string,
    ): Promise<ResolvedSource | null> {
        const id = sourceId ?? track.source;
        await ensureCoreSources();

        // 桌面宿主：核心按候选顺序回退，并返回**回环代理**地址
        // （WebView 的 <audio> 无法设置 Referer/UA/Cookie，必须经代理播放）。
        // 核心认识的源**与本地文件（`local:` 伪源）**都交给核心；
        // 只有内置演示源走下面的本地实现。
        if (isCorePlayableSource(id)) {
            const viaCore = await coreResolveUrl(this.trackRef(id, track), quality);
            if (viaCore) {
                return {url: viaCore.url, source: viaCore.source, quality: viaCore.quality as TrackQuality};
            }
        }

        const plugin = getMusicSource(id);
        if (!plugin) return null;
        return plugin.resolveUrl(track, quality);
    },

    /** 统一曲目引用 `source:rawId`；避免 id 已经带前缀时重复拼接 */
    trackRef(sourceId: string, track: Track): string {
        return track.id.startsWith(`${sourceId}:`) ? track.id : `${sourceId}:${track.id}`;
    },

    /**
     * 媒体失败后问核心「上游到底回了什么」（`playback.diagnose`）。
     *
     * 只在**媒体加载失败**之后调用：它解释「为什么没声音」，不参与播放决策。
     * 没有核心、核心不认识这个源、或代理还没看到任何响应 → `null`，
     * 界面按原来的「音频加载失败」说，不编原因。
     */
    async diagnoseUpstream(track: Track, sourceId?: string): Promise<UpstreamVerdict | null> {
        const id = sourceId ?? track.source;
        // 演示源不经代理，问了也只是噪声
        if (!isCorePlayableSource(id)) return null;
        return coreDiagnoseUpstream(this.trackRef(id, track));
    },
};
