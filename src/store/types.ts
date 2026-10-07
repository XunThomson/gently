import type {ColorScheme, ThemeMode, ThemeSkin} from '../theme';
import type {
    ChartType,
    DateSelection,
    DownloadTask,
    LocalTrack,
    LyricLine,
    NowPlaying,
    Period,
    Playlist,
    PluginInfo,
    RecentTrack,
    RecommendationBundle,
    RepeatMode,
    SongRow,
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
    /** 用户导入的皮肤 */
    customSkins: ThemeSkin[];
}

export interface PlayerState {
    current: NowPlaying | null;
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
    /** 当前曲目歌词（随播放切换异步加载） */
    lyrics: LyricLine[];
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
}

export interface RankingState {
    chart: ChartType;
    period: Period;
    date: DateSelection;
    weekStart: DateSelection;
    /** 榜单列表是否展开全部 */
    expanded: boolean;
    /** 榜单内搜索关键词 */
    query: string;
    /** 当前榜单数据 */
    rows: SongRow[];
    loading: boolean;
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
    isGroupCollapsed: (key: string) => boolean;
    setSearchQuery: (query: string) => void;
    setSourceDisplay: (mode: SourceDisplayMode) => void;
    setSourceFilterStyle: (style: SourceFilterStyle) => void;
    setSourceFilter: (sourceId: string) => void;
    setPreferredSource: (sourceId: string | null) => void;
    setPreferredQuality: (quality: TrackQuality) => void;
    setConfirmDestructive: (enabled: boolean) => void;
    /** 安装（导入）一个皮肤 */
    installSkin: (skin: ThemeSkin) => void;
    removeSkin: (skinId: string) => void;
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
    /** 音源不可用：退回模拟时钟 */
    markUnplayable: () => void;
    seek: (seconds: number) => void;
    stop: () => void;
    /** 手动切换当前曲目的音源 */
    switchSource: (sourceId: string) => void;
    /** 音质偏好变化后重新解析当前曲目 */
    reloadSource: () => void;
    /* ---- 队列控制 ---- */
    /** 从队列移除（当前曲目不可移除） */
    removeFromQueue: (trackId: string) => void;
    /** 在队列中上移 / 下移 */
    moveInQueue: (trackId: string, offset: -1 | 1) => void;
    /** 清空队列（保留当前曲目） */
    clearQueue: () => void;
}

export interface RankingActions {
    /** 切换查询条件并重新加载（返回 Promise，便于等待或忽略） */
    setChart: (chart: ChartType) => Promise<void>;
    setPeriod: (period: Period) => Promise<void>;
    setDate: (date: DateSelection) => Promise<void>;
    toggleExpanded: () => void;
    setQuery: (query: string) => void;
    /** 按当前查询条件拉取榜单 */
    load: () => Promise<void>;
}

export interface DownloadActions {
    load: () => Promise<void>;
    /** 加入下载队列（当前为 mock：直接生成一个等待中的任务） */
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
    setEnabled: (id: string, enabled: boolean) => void;
    remove: (id: string) => void;
    /** 更新到最新版本（mock：仅改版本号占位） */
    update: (id: string) => void;
}

export interface LibraryActions {
    load: () => Promise<void>;
    setQuery: (query: string) => void;
    /** 记录一次播放：写入最近播放 */
    recordPlay: (track: Track) => void;
    clearRecent: () => void;
    removeLocal: (id: string) => void;
}

export interface CollectionActions {
    load: () => Promise<void>;
    isFavorite: (trackId: string) => boolean;
    toggleFavorite: (track: Track) => void;
    /** 新建歌单，返回创建结果，便于调用方立即使用 */
    createPlaylist: (name: string) => Playlist;
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
