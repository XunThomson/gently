/**
 * 应用行为配置（**非样式**）。
 *
 * 分工：
 * - 样式元数据（颜色 / 尺寸 / 字体 / 圆角 / 动效 / 组件度量）→ `src/config/theme/theme.config.json`
 * - 主题市场预设 → `src/config/theme/presets.json`
 * - 行为与规模（窗口 / 播放器 / 列表条数 / 下载引擎 / mock 数据规模）→ 本文件
 *
 * 这里的值是「产品行为」而非「主题皮肤」，因此不放主题文件：
 * 主题可以在运行时切换，行为参数在构建期确定。
 */
export const appConfig = {
    /** 窗口尺寸；原生窗口的初始尺寸另见 src-tauri/tauri.conf.json */
    window: {
        compact: {width: 420, height: 320},
        normal: {width: 1180, height: 760},

        /**
         * 外壳形态阈值（行为配置，不是样式）。
         *
         * - 宽 < miniWidth 或高 < miniHeight → 迷你播放器（整个外壳替换）；
         * - 否则宽 < compactWidth → 紧凑模式（侧栏收成图标栏、标题栏收紧）；
         * - 其余 → 完整界面。
         *
         * 紧凑只看宽度：侧栏 / 标题栏挤不挤是横向问题；窗口矮的时候直接进迷你，
         * 不为了「矮」把宽窗口的侧栏标签无故收掉。
         */
        breakpoints: {
            compactWidth: 960,
            miniWidth: 720,
            miniHeight: 480,
        },
    },

    /**
     * 手机外壳的行为参数（非样式；尺寸/配色仍走 `theme.config.json`）。
     *
     * `statusBarInset`：安卓端是 edge-to-edge（webview 铺到状态栏底下），
     * 所以顶部要多留一条，否则标题会被状态栏的时钟压住（实测 2026-11-01）。
     * 这是**设备量出来的近似值**（1080×2400 / dpr 3 → 30 CSS px）；
     * 精确值要靠宿主上报状态栏高度，等 P2 接前台服务时一起做。
     */
    mobile: {
        statusBarInset: 30,
    },

    player: {
        /** 初始音量 0~1 */
        defaultVolume: 0.8,
        /** 键盘调整音量的步长 */
        volumeStep: 0.05,
        /** 进度条 ←/→ 微调步长（秒） */
        seekStepSec: 5,
        /** 播放超过该秒数时，「上一首」先回到开头而不是切歌 */
        restartThresholdSec: 3,
        /**
         * 推荐反馈的负信号门槛：一次播放听到不到这个比例就被切走 → 报 `skip`。
         * 与核心的判定线一致（`core/src/recommend.rs` 只把 `progress < 0.5` 的跳过当负信号）。
         */
        feedbackSkipRatio: 0.5,
        /** 无真实音源时，回退时钟的推进间隔（毫秒） */
        fallbackTickMs: 1000,
    },

    list: {
        /** 榜单/分类每页条数（mock 数据源的分页粒度；真实源由它自己决定） */
        topListPageSize: 10,
        /** 热门推荐条数 */
        recommendLimit: 12,
        /** 源侧推荐（`catalog.recommend`）展示条数：插件自己决定给多少，这里只取前 N 条 */
        recommendSourceLimit: 6,
        /** 推荐专辑条数 */
        albumLimit: 4,
        /** 推荐歌单条数 */
        playlistLimit: 4,
        /** 搜索结果上限 */
        searchLimit: 20,
        /** 最近播放最多保留条数 */
        recentLimit: 100,
    },

    download: {
        /** mock 下载引擎每秒推进的进度 0~1 */
        progressPerTick: 0.03,
        /** 文件大小估算：每多少秒时长 ≈ 1MB */
        secondsPerMb: 30,
        /** 默认同时下载的歌曲数（设置页可调） */
        maxConcurrent: 3,
        /** 设置页可选的并发档位（够用即可，不做无级滑杆） */
        maxConcurrentOptions: [1, 2, 3, 4],
        /** 默认下载音质 */
        defaultQuality: 'high',
        /** 首选音质不可用时默认往哪边取 */
        defaultQualityFallback: 'lower',
    },

    background: {
        /** 本地视频背景上限（超过就拒绝导入，避免把用户磁盘/内存拖垮） */
        maxVideoBytes: 512 * 1024 * 1024,
        /** 单文件网页壁纸上限（HTML 会进 IndexedDB，过大会拖慢启动） */
        maxWebBytes: 1024 * 1024,
        /** 视频背景允许的播放速度范围 */
        minPlaybackRate: 0.25,
        maxPlaybackRate: 2,
        /** 背景虚化上限（CSS 全屏 blur 很贵，不给无界滑杆） */
        maxBlurPx: 24,
        /** 内容表面透明度下限：再低文字会失去可读背景 */
        minContentOpacity: 0.1,
        /** 抽屉/浮层表面透明度下限；与内容表面独立控制 */
        minDrawerOpacity: 0.1,
    },

    /** 歌词 mock 生成参数（接入真实歌词后仅保留展示相关配置） */
    lyrics: {
        /** 首行歌词前的留白（秒） */
        leadInSec: 5,
        /** 末行之后留白（秒） */
        leadOutSec: 6,
        verseLines: 6,
        verseRepeatLines: 4,
        outroLines: 2,
        /**
         * 自动跟随的滚动缓动：每帧向目标靠近的比例（0~1）。
         * 0.22 在 60fps 下约 0.35s 走完大半距离，读起来像滑行而不是跳转。
         */
        followStep: 0.22,
        /** 用户手动滚动后，暂停自动跟随的时长（毫秒） */
        followSuspendMs: 4000,
        /** 距目标小于该像素即认为已对齐，停止动画（避免亚像素抖动写满每一帧） */
        followSettlePx: 1,
    },

    /** mock 数据规模：调大可直接看密集列表的排版表现 */
    mock: {
        localTracks: 8,
        recentTracks: 6,
        favoriteTracks: 4,
        playlistCount: 2,
        playlistTrackCounts: [3, 4],
        downloadTasks: 6,
    },

    /** mock 数据源 / 本地门面的模拟延迟（毫秒），便于观察加载态 */
    latency: {
        sourceMs: 160,
        libraryMs: 120,
        lyricsMs: 80,
    },
} as const;
