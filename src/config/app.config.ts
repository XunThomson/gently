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
        /** 无真实音源时，回退时钟的推进间隔（毫秒） */
        fallbackTickMs: 1000,
    },

    list: {
        /** 榜单默认展示条数（展开前） */
        chartVisible: 10,
        /** 单个榜单生成条数 */
        chartSize: 20,
        /** 热门推荐条数 */
        recommendLimit: 12,
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
