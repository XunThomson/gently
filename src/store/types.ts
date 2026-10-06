import type {ColorScheme, ThemeMode} from '../theme';
import type {
    ChartType,
    DateSelection,
    DownloadTask,
    LocalTrack,
    NowPlaying,
    Period,
    PluginInfo,
    RecentTrack,
    RepeatMode,
    SongRow,
    Track,
} from '../types';

/* ============================== 切片 State ============================== */

export interface UiState {
    themeMode: ThemeMode;
    /** 由 ThemeProvider 写入的实际配色方案 */
    scheme: ColorScheme;
    /** 侧边栏中已折叠的分组 */
    collapsedGroups: string[];
    /** 顶栏全局搜索关键词（空串代表未搜索） */
    searchQuery: string;
}

export interface PlayerState {
    current: NowPlaying | null;
    playing: boolean;
    /** 播放队列（不含 current 本身） */
    queue: Track[];
    index: number;
    repeat: RepeatMode;
    /** 0 ~ 1 */
    volume: number;
    /** 已播放秒数 */
    elapsed: number;
    /** 当前曲目总秒数 */
    duration: number;
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

export interface RootState {
    ui: UiState;
    player: PlayerState;
    ranking: RankingState;
    download: DownloadState;
    plugin: PluginState;
    library: LibraryState;
}

/* ============================== 切片 Actions ============================== */

export interface UiActions {
    setThemeMode: (mode: ThemeMode) => void;
    setScheme: (scheme: ColorScheme) => void;
    toggleGroup: (key: string) => void;
    isGroupCollapsed: (key: string) => boolean;
    setSearchQuery: (query: string) => void;
}

export interface PlayerActions {
    /** 播放指定曲目；传入 queue 则整体替换播放队列 */
    play: (track: Track, queue?: Track[]) => void;
    toggle: () => void;
    next: () => void;
    prev: () => void;
    setRepeat: (mode: RepeatMode) => void;
    setVolume: (volume: number) => void;
    /** 播放进度 +1s，由播放引擎驱动 */
    tick: () => void;
    seek: (seconds: number) => void;
    stop: () => void;
}

export interface RankingActions {
    /** 切换查询条件并重新加载（返回 Promise，便于等待或忽略） */
    setChart: (chart: ChartType) => Promise<void>;
    setPeriod: (period: Period) => Promise<void>;
    setDate: (date: DateSelection) => Promise<void>;
    setWeekStart: (weekStart: DateSelection) => Promise<void>;
    toggleExpanded: () => void;
    setQuery: (query: string) => void;
    /** 按当前查询条件拉取榜单 */
    load: () => Promise<void>;
}

export interface DownloadActions {
    load: () => Promise<void>;
    /** 从队列移除（已下载的为删除文件记录） */
    remove: (id: string) => void;
    pause: (id: string) => void;
    resume: (id: string) => void;
    clearFinished: () => void;
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

export interface RootActions {
    ui: UiActions;
    player: PlayerActions;
    ranking: RankingActions;
    download: DownloadActions;
    plugin: PluginActions;
    library: LibraryActions;
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
