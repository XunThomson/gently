import type {ColorScheme, ThemeMode, ThemeSkin} from '../theme';
import type {CoreError, LocalScanResult, TopListGroup} from '../api';
import type {
    BackgroundAsset,
    BackgroundKind,
    BackgroundOptions,
    BackgroundPreset,
    BackgroundSettings,
    WebAsset,
} from '../utils/backgroundSettings';
import type {
    DownloadQualityFallback,
    DownloadTask,
    LocalTrack,
    LyricLine,
    NowPlaying,
    Playlist,
    PluginInfo,
    RecentTrack,
    RecommendationBundle,
    RepeatMode,
    SourceDisplayMode,
    SourceFilterStyle,
    Track,
    TrackCandidate,
    TrackQuality,
} from '../types';

/* ============================== 切片 State ============================== */

export interface UiState {
    themeMode: ThemeMode;
    /** 主题市场当前预设 id */
    themePresetId: string;
    /** 由 ThemeProvider 写入的实际配色方案 */
    scheme: ColorScheme;
    /** 侧边栏中已折叠的分组 */
    collapsedGroups: string[];
    /** 顶栏全局搜索关键词（空串代表未搜索） */
    searchQuery: string;
    /** 音源展示方式：聚合 / 分源 */
    sourceDisplay: SourceDisplayMode;
    /** 本地视频背景 + 展示参数预设 */
    background: BackgroundSettings;
    /** 页面音源筛选的交互样式 */
    sourceFilterStyle: SourceFilterStyle;
    /** 当前页面选中的音源；'all' 表示全部 */
    sourceFilter: string;
    /** 优先音源；null 表示自动（按注册顺序） */
    preferredSource: string | null;
    /** 优先音质 */
    preferredQuality: TrackQuality;
    /** 危险操作前是否二次确认 */
    confirmDestructive: boolean;
    /** 下载目录；空串表示用核心默认目录（`<data>/downloads`） */
    downloadDir: string;
    /** 默认下载音质 */
    downloadQuality: TrackQuality;
    /** 首选音质不可用时往哪边取 */
    downloadQualityFallback: DownloadQualityFallback;
    /** 最多同时下载的歌曲数（1~4） */
    downloadMaxConcurrent: number;
    /** 用户导入的皮肤 */
    customSkins: ThemeSkin[];
    /** 桌面歌词窗口是否可见（窗口状态，不持久化） */
    desktopLyricsOpen: boolean;
    /**
     * 「发现」视图聚焦时自动试听高潮片段。
     *
     * **显式默认开启项**（`true`）：用户划过/选中一张包装就能听到这首歌；
     * 不想被打扰可以在设置页关掉（关掉后只展示封面与动效，不发声）。
     */
    discoverAutoPreview: boolean;
    /**
     * 宠物（实验，默认关）。
     *
     * 宠物是 2.x 的形态，音乐软件现在还在 1.x：默认不注册任何宠物（`PetHost` 渲染 null）。
     * 打开后由 App 注册内置宠物，走 `pet-core`（独立引擎、独立库，ADR 0010）。
     */
    petEnabled: boolean;
    /**
     * 宠物注册表的「重挂信号」：安装/切换/卸载宠物后 +1。
     *
     * 渲染器在 mount 时读一次「当前出战是谁」，所以这几种操作之后必须让它重新挂一次；
     * 用计数器而不是把幂等逻辑塞进组件里，是为了让「什么时候需要重挂」只有一个来源。
     */
    petRevision: number;
}

/** 一份歌词的来路（自动加载 / 用户从搜索结果里挑的） */
export interface LyricSourceInfo {
    /** 插件 id（自动加载时是曲目自身的源） */
    source: string;
    /** 插件显示名（界面展示用；拿不到时退回 id） */
    sourceName: string;
    /** 这份歌词对应的曲目标题 / 歌手（各源同名歌曲可能不一致，界面要能区分） */
    title: string;
    artist: string;
    /**
     * 该插件内的曲目 id（手动挑选时才带）。
     *
     * 有了它才能拼出 `source:trackId` 的歌词引用、把「手动挑的来路」按曲目记住
     * （`utils/lyricsSyncCache.ts`）——下次播放同一首时先按这条来路取词。
     */
    trackId?: string;
}

export interface PlayerState {
    current: NowPlaying | null;
    /**
     * 当前曲目的**源侧详情**（`catalog.track`，播放时异步补）。
     *
     * 列表里的快照常常缺封面/专辑（搜索结果只有标题歌手）；这里拿到的是源给的完整元数据，
     * 播放条与歌词页用它渲染封面。为 `null` 表示「源没提供」或「还在路上」——界面继续用快照。
     */
    detail: Track | null;
    playing: boolean;
    /** 播放队列（含当前曲目，index 指向当前） */
    queue: Track[];
    index: number;
    repeat: RepeatMode;
    /** 0 ~ 1 */
    volume: number;
    /** 已播放秒数 */
    elapsed: number;
    /** 当前曲目总秒数（优先取音频元数据） */
    duration: number;
    /**
     * 进度**被改动过**的次数（拖进度条 / 点进度条 / 续播跳位时 +1）。
     *
     * 为什么需要：手机的通知栏 / 锁屏要知道「放到哪」才能画进度条，但订阅 `elapsed` 会把整棵外壳
     * 每秒重渲染好几次。这里只暴露「进度跳变了一次」这个事实，订阅方在回调里再按需
     * `store.getState()` 读准确位置（R117）。
     */
    seekSeq: number;
    /** 当前曲目歌词（随播放切换异步加载；用户手动挑选的也放这里） */
    lyrics: LyricLine[];
    /**
     * 当前歌词来自哪里。
     * 自动加载 = 曲目自身的源；用户从「搜索歌词」里选了一份 = 那份结果的源与曲目信息。
     * `null` 表示还没有歌词（或加载中），界面据此决定要不要显示来源行。
     */
    lyricsSource: LyricSourceInfo | null;
    /**
     * 歌词时间轴偏移（秒）。正值 = 歌词比音频**晚**，渲染时用 `elapsed + lyricsOffset`。
     * 按曲目持久化（`utils/lyricsOffset.ts`），切歌时读回该曲目上次校正过的值。
     */
    lyricsOffset: number;
    /** 由数据源解析出的可播放地址 */
    audioUrl: string | null;
    /** 是否存在真实音源：false 时退回模拟时钟 */
    playable: boolean;
    /** 当前曲目的音源候选（按尝试顺序） */
    candidates: TrackCandidate[];
    /** 实际在播的音源 id */
    activeSource: string | null;
    /** 实际在播的音质 */
    quality: TrackQuality | null;
    /** 已尝试且失败的音源 id（UI 用于标记不可用） */
    failedSources: string[];
    /** 是否正在解析音源 */
    resolving: boolean;
    /**
     * 最近一次播放失败的原因；`null` 表示没问题。
     *
     * 为什么必须存在：以前解析失败 / 媒体加载失败只把 `playable` 置 false，而 `playing` 仍为 true、
     * 回退时钟继续推进进度——界面看起来在放，实际**完全没有声音**，也没有任何提示（R71 用户报的
     * 「player 在播放、实际没有播放」）。现在失败就**停表并说明原因**。
     */
    playbackError: PlaybackFailure | null;
}

/**
 * 播放失败：要么所有候选源都解析不到地址，要么媒体元素自己报错，
 * 要么**系统把播放管道掐了**（安卓锁屏/后台一段时间后 `play()` 既不成也不报错），
 * 要么**上游回的根本不是音频**（`HTTP 200 + HTML 错误页`，R110 的坑——界面上必须与
 * 「解码失败」分开说，因为处理方式完全不同：换源 / 重新登录，而不是等一等）。
 */
export interface PlaybackFailure {
    kind: 'noSource' | 'media' | 'notAudio' | 'interrupted';
    /** 已经试过的音源 id（界面可以说「3 个源都试过了」）；`interrupted` 时为空。 */
    failedSources: string[];
    /** 媒体的原始错误（错误码 / 异常文本），只作为次要说明 */
    detail?: string;
}

/**
 * 榜单/分类切片。
 *
 * **结构由源决定**（契约 `catalog.topLists` / `catalog.topList`）：这里只保存
 * 「源给的分类树 + 当前选中项 + 已加载的页」，不假设「日/周/月」或「热歌/新歌」这种固定枚举。
 */
export interface RankingState {
    /** 当前生效的源 id（`all` 已换算成实际源） */
    sourceId: string | null;
    /** 该源的分类树 */
    groups: TopListGroup[];
    /** 当前选中的分类条目 id */
    selectedId: string | null;
    /** 已加载的曲目（翻页累加） */
    rows: Track[];
    /** 源说还有下一页（缺字段不猜） */
    hasMore: boolean;
    nextPage?: number;
    loading: boolean;
    /** 分类树是否已加载过（区分「加载中」与「这个源没有分类」） */
    loaded: boolean;
    /**
     * 源报错时的原始错误（`source.upstream_failed` / `plugin.runtime_error` …）。
     *
     * 有它才能把「这个源没有榜单」和「源跑挂了」区分开——界面按码取本地化文案，
     * 而不是一律显示「没有提供榜单」（那会把用户引到完全错误的方向）。
     */
    error: CoreError | null;
}

export interface DownloadState {
    tasks: DownloadTask[];
    loaded: boolean;
}

export interface PluginState {
    list: PluginInfo[];
    loaded: boolean;
}

export interface LibraryState {
    local: LocalTrack[];
    recent: RecentTrack[];
    /** 本地音乐搜索关键词 */
    query: string;
    /** 是否已从数据源加载 */
    loaded: boolean;
    /** 正在扫描本地目录（进度见 `scanProgress`） */
    scanning: boolean;
    /** 扫描进度（`library:scan:progress` 事件；扫描结束后清空） */
    scanProgress: {dir: string; found: number; percent?: number} | null;
    /** 上一次扫描的统计结果（界面如实说明做了什么） */
    scanSummary: LocalScanResult | null;
    /** 上一次扫描的失败原因 */
    scanError: CoreError | null;
}

/** 收藏与歌单 */
export interface CollectionState {
    favorites: Track[];
    playlists: Playlist[];
    loaded: boolean;
}

/**
 * 二次确认：一次只挂一个请求。
 * `onConfirm` 是命令而不是数据，因此不参与持久化。
 */
export interface ConfirmRequest {
    /** i18n key */
    titleKey: string;
    /** i18n key */
    descKey?: string;
    /** 插值参数（如 {{name}}） */
    descParams?: Record<string, string | number>;
    /** danger 用红色主按钮 */
    tone?: 'default' | 'danger';
    onConfirm: () => void;
}

export interface DialogState {
    confirm: ConfirmRequest | null;
}

/** 个性化推荐 */
export interface RecommendState {
    bundle: RecommendationBundle | null;
    loading: boolean;
    loaded: boolean;
    /** 源侧推荐（`catalog.recommend`）：当前音源自己给的推荐，与上面的画像推荐并存 */
    sourceTracks: Track[];
    /** 源侧推荐来自哪个源（界面显示名字用） */
    sourceId: string | null;
    sourceLoading: boolean;
    sourceLoaded: boolean;
}

export interface RootState {
    ui: UiState;
    player: PlayerState;
    ranking: RankingState;
    download: DownloadState;
    plugin: PluginState;
    library: LibraryState;
    collection: CollectionState;
    dialog: DialogState;
    recommend: RecommendState;
}

/* ============================== 切片 Actions ============================== */

export interface UiActions {
    setThemeMode: (mode: ThemeMode) => void;
    setThemePreset: (presetId: string) => void;
    setScheme: (scheme: ColorScheme) => void;
    toggleGroup: (key: string) => void;
    setSearchQuery: (query: string) => void;
    setSourceDisplay: (mode: SourceDisplayMode) => void;
    setSourceFilterStyle: (style: SourceFilterStyle) => void;
    setSourceFilter: (sourceId: string) => void;
    setPreferredSource: (sourceId: string | null) => void;
    setPreferredQuality: (quality: TrackQuality) => void;
    setConfirmDestructive: (enabled: boolean) => void;
    /** 下载目录（空串 = 核心默认目录） */
    setDownloadDir: (dir: string) => void;
    setDownloadQuality: (quality: TrackQuality) => void;
    setDownloadQualityFallback: (fallback: DownloadQualityFallback) => void;
    /** 同时下载数；超出 1~4 会被钳到边界 */
    setDownloadMaxConcurrent: (count: number) => void;
    /** 桌面歌词窗口的可见状态（由窗口服务 / 窗口间事件同步） */
    setDesktopLyricsOpen: (open: boolean) => void;
    /** 背景开关 */
    setBackgroundEnabled: (enabled: boolean) => void;
    /** 「发现」视图聚焦时自动试听（默认开，可关） */
    setDiscoverAutoPreview: (enabled: boolean) => void;
    /** 宠物实验开关（默认关；打开后注册内置宠物） */
    setPetEnabled: (enabled: boolean) => void;
    /** 宠物集合变了（安装/切换/卸载）：让渲染器重新挂一次 */
    bumpPetRevision: () => void;
    /** 切换素材类型（视频 / 单文件网页），两种素材都保留 */
    setBackgroundKind: (kind: BackgroundKind) => void;
    /** 系统减少动态效果时是否仍显示背景（用户显式覆盖） */
    setBackgroundPlayWhenReducedMotion: (play: boolean) => void;
    /** 视频背景 Blob 已由服务层保存，这里只记录元数据 */
    setBackgroundAsset: (asset: BackgroundAsset | null) => void;
    /** 单文件网页壁纸已由服务层保存，这里只记录元数据 */
    setBackgroundWeb: (web: WebAsset | null) => void;
    /** 手动调整展示参数：会清掉「当前预设」标记，避免显示成预设原样 */
    setBackgroundOptions: (patch: Partial<BackgroundOptions>) => void;
    /** 把当前展示参数存成命名预设（上限 30 个） */
    saveBackgroundPreset: (name: string) => void;
    applyBackgroundPreset: (id: string) => void;
    renameBackgroundPreset: (id: string, name: string) => void;
    removeBackgroundPreset: (id: string) => void;
    /** 导入外部预设（已由解析器归一化） */
    addBackgroundPreset: (preset: BackgroundPreset) => void;
    /** 恢复默认背景：清当前视频与参数，保留用户命名的预设 */
    resetBackground: () => void;
    /** 安装（导入）一个皮肤 */
    installSkin: (skin: ThemeSkin) => void;
    removeSkin: (skinId: string) => void;
    /** 从本机核心读取已安装的用户皮肤（浏览器预览是空操作，沿用本地持久化的那份） */
    loadSkins: () => Promise<void>;
}

export interface DialogActions {
    /** 请求二次确认；`confirmDestructive` 关闭时会直接执行 */
    requestConfirm: (request: ConfirmRequest) => void;
    /** 用户确认 */
    resolveConfirm: () => void;
    /** 用户取消 */
    cancelConfirm: () => void;
}

export interface RecommendActions {
    /** 生成推荐；`force` 为 true 时即使已加载也重新计算 */
    load: (force?: boolean) => Promise<void>;
    /** 拉当前音源的推荐（`catalog.recommend`）；`force` 为 true 时重新拉一次 */
    loadSource: (force?: boolean) => Promise<void>;
    /**
     * 「不感兴趣」：上报负反馈（`skip` + `progress: 0`，核心只认 < 0.5 的跳过）
     * 并把它从当前列表里去掉——画像下次打分就会压低这类标签/歌手。
     */
    dislike: (track: Track) => void;
}

export interface PlayerActions {
    /** 播放指定曲目；传入 queue 则整体替换播放队列 */
    play: (track: Track, queue?: Track[]) => void;
    /**
     * 列表行的标准点击行为：
     * 点的是当前曲目 → 播放 / 暂停切换；否则切歌播放。
     */
    playOrToggle: (track: Track, queue?: Track[]) => void;
    toggle: () => void;
    next: () => void;
    prev: () => void;
    setRepeat: (mode: RepeatMode) => void;
    setVolume: (volume: number) => void;
    /** 播放进度 +1s，由播放引擎驱动（无真实音源时的回退时钟） */
    tick: () => void;
    /** 由音频引擎回写真实进度与时长 */
    setProgress: (elapsed: number, duration: number) => void;
    /**
     * 媒体引擎报错（加载 / 解码 / 播放策略拒绝）。
     *
     * 行为：**先换源**——把当前音源记为失败，用还没试过的候选继续解析（多源回退的应有之义）；
     * 全都没了才停播（`playing:false`）并把原因写进 `playbackError`，让界面能说清「为什么没声音」。
     */
    markUnplayable: (message?: string) => void;
    /** 重试当前曲目：重新解析全部候选音源并继续播放 */
    retryPlayback: () => void;
    /**
     * 系统掐断播放管道（不是源的错）时如实停表：安卓锁屏 / 后台一段时间后，
     * 媒体元素的 `play()` 既不会成功也不会报错，界面会一直显示「播放中、进度不动」。
     *
     * 与 `markUnplayable` 的区别：**不换源**——地址是好的，换源只会白打一轮网络请求。
     */
    markInterrupted: () => void;
    /**
     * 「接着播」：系统休眠 / 长时间失焦回来、媒体元素已经停了时由播放引擎调用。
     *
     * 与 `retryPlayback` 的区别只有一处但很关键：**保留当前进度**。
     * 回环代理的流地址有 30 分钟 TTL，上游给的直链也常常几分钟就失效，
     * 所以恢复的第一步永远是「让核心重新解析一次」，拿回来的新地址才能继续播。
     */
    recoverPlayback: () => void;
    /**
     * 当前候选都不可播时，按「歌名 + 歌手」跨源搜索并合并新的候选。
     *
     * 只在用户点「换源」时调用（不是失败自动触发）：一次失败不应该自动放大成
     * 一轮全源网络请求。榜单/收藏/历史曲目通常没有 candidates，正是这个方法补的。
     */
    findAlternatives: () => Promise<void>;
    seek: (seconds: number) => void;
    stop: () => void;
    /** 手动切换当前曲目的音源 */
    switchSource: (sourceId: string) => void;
    /** 音质偏好变化后重新解析当前曲目 */
    reloadSource: () => void;
    /**
     * 应用一份**手动挑选**的歌词（来自歌词搜索）。
     * 会覆盖自动加载的歌词；在本次播放内不再被自动加载覆盖。
     */
    applyLyrics: (lines: LyricLine[], source: LyricSourceInfo) => void;
    /**
     * 忘掉手动挑的歌词来路，回到「源自动给的词」。
     *
     * 校正过的偏移**保留**：它仍可能适用于源给的词（同一首、同一版本），
     * 由用户自己决定要不要一起归零。
     */
    restoreAutoLyrics: () => void;
    /** 设置歌词时间轴偏移（秒，正 = 歌词比音频晚）；按当前曲目持久化 */
    setLyricsOffset: (seconds: number) => void;
    /**
     * 在当前偏移上增减（秒）。
     *
     * 校正按钮与方向键都走这里：连点时每次都读到**最新**偏移，而不是闭包里那份旧值
     * （连续点 5 下 +0.1 只加一次 0.1 是这类 UI 最常见的坑）。
     */
    nudgeLyricsOffset: (delta: number) => void;
    /* ---- 队列控制 ---- */
    /** 从队列移除（当前曲目不可移除） */
    removeFromQueue: (trackId: string) => void;
    /** 在队列中上移 / 下移 */
    moveInQueue: (trackId: string, offset: -1 | 1) => void;
    /** 清空队列（保留当前曲目） */
    clearQueue: () => void;
}

export interface RankingActions {
    /** 加载分类树（并按需选中默认条目） */
    load: () => Promise<void>;
    /** 切换分类：重新从第一页开始加载 */
    selectItem: (itemId: string) => Promise<void>;
    /** 加载下一页并追加（`hasMore` 为 false 时是空操作） */
    loadMore: () => Promise<void>;
}

export interface DownloadActions {
    /** 读任务列表；`force` 为 true 时重新读一次（并重新订阅核心事件） */
    load: (options?: {force?: boolean}) => Promise<void>;
    /** 加入下载队列（桌面端交给核心；核心拒绝时会在列表里留下带错误码的任务） */
    add: (track: Track) => void;
    /** 从队列移除（已下载的为删除文件记录） */
    remove: (id: string) => void;
    pause: (id: string) => void;
    resume: (id: string) => void;
    clearFinished: () => void;
    /** 下载引擎每秒推进一步，由 useDownloadEngine 驱动 */
    tick: () => void;
}

export interface PluginActions {
    load: () => Promise<void>;
    /**
     * 强制重读插件清单（含按源路由缓存）。
     *
     * 导入 / 卸载 / 启停 / 改优先级之后必须调用：`load()` 有 `loaded` 守卫，
     * 只在启动时读一次；不刷新的话刚装好的插件要等重启才出现在列表里（R87 的 bug）。
     */
    reload: () => Promise<void>;
    setEnabled: (id: string, enabled: boolean) => void;
    remove: (id: string) => void;
    /** 检查更新：桌面端与来源比对版本，浏览器预览退回 mock 的版本号占位 */
    update: (id: string) => void | Promise<void>;
}

export interface LibraryActions {
    /** 读本地曲库与最近播放；`force` 为 true 时重新读一次（扫描完要用它刷新列表） */
    load: (options?: {force?: boolean}) => Promise<void>;
    setQuery: (query: string) => void;
    /**
     * 扫描本地目录并入库（桌面端 `library.local.scan`）。
     *
     * 结束后**强制重读列表**：扫描的成果必须立刻出现在页面上，否则用户会以为没生效。
     */
    scan: (input: {dirs: string[]; recursive?: boolean}) => Promise<void>;
    /** 记录一次播放：写入最近播放 */
    recordPlay: (track: Track) => void;
    clearRecent: () => void;
    removeLocal: (id: string) => void;
    /**
     * 清理「从手机导入进来的副本」：连**磁盘文件**一起删（R119）。
     *
     * 与 `removeLocal` 的区别：那个只移出曲库（文件留着，安全）；这里是用户明确要腾空间，
     * 所以只动导入目录里的文件——他自己扫描进来的音乐一个都不碰。返回清理的条数。
     */
    purgeImported: () => Promise<number>;
}

export interface CollectionActions {
    load: () => Promise<void>;
    isFavorite: (trackId: string) => boolean;
    toggleFavorite: (track: Track) => void;
    /** 新建歌单，返回创建结果，便于调用方立即使用 */
    /**
     * 新建歌单；`tracks` 是**初建就要放进去**的曲目。
     *
     * 必须一次带上去：桌面端歌单 id 由**核心**生成，本地先用的占位 id（`pl:…`）核心不认识，
     * 建完再「补一次写入」只会拿到 `common.not_found`（R40 实测：界面提示「已加入」、
     * 歌单里却是 0 首）。带初值后核心在建的时候就把曲目存好，返回的 `saved` 里带着它们。
     */
    createPlaylist: (name: string, tracks?: Track[]) => Playlist;
    renamePlaylist: (id: string, name: string) => void;
    removePlaylist: (id: string) => void;
    addToPlaylist: (playlistId: string, track: Track) => void;
    removeFromPlaylist: (playlistId: string, trackId: string) => void;
}

export interface RootActions {
    ui: UiActions;
    player: PlayerActions;
    ranking: RankingActions;
    download: DownloadActions;
    plugin: PluginActions;
    library: LibraryActions;
    collection: CollectionActions;
    dialog: DialogActions;
    recommend: RecommendActions;
}

/** 切片工厂上下文 */
export interface StoreCtx {
    getState: () => RootState;
    setState: (patch: Partial<RootState>) => void;
    getActions: () => RootActions;
}

export interface Slice<K extends keyof RootState, A> {
    key: K;
    state: RootState[K];
    actions: A;
}
