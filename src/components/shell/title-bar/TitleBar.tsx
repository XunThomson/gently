import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {useActions, useSelect} from '../../../store';
import {catalogService, coreAvailable, isTauri, windowService} from '../../../services';
import {HOT_SEARCH_WORDS} from '../../../mock/search.mock';
import {useTheme} from '../../../theme';
import {SearchBox, type SearchSuggestion} from '../../ui/search-box';
import {Logo} from './Logo';
import {Toolbar} from './Toolbar';
import styles from './title-bar.module.css';

/**
 * 标题栏：品牌 + 全局搜索 + 工具栏。
 * 搜索状态集中在 store 的 ui/searchQuery，提交后跳转到「热门推荐」展示结果。
 *
 * `compact`（窗口进入紧凑模式）只收起品牌文字并收紧间距；
 * 搜索框与全部工具按钮都保留——它们在其他地方没有替代入口。
 */
export function TitleBar({compact = false}: {compact?: boolean}) {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const {setSearchQuery, setThemeMode, setDesktopLyricsOpen} = useActions().ui;
    const searchQuery = useSelect((s) => s.ui.searchQuery);
    const scheme = useSelect((s) => s.ui.scheme);
    const preferredSource = useSelect((s) => s.ui.preferredSource);
    const activeSource = useSelect((s) => s.player.activeSource);
    const currentSource = useSelect((s) => s.player.current?.source ?? null);
    const desktopLyricsOpen = useSelect((s) => s.ui.desktopLyricsOpen);
    /* 联想优先用用户指定/正在播的源：桌面端前端注册表为空，只有问核心才有结果；
       不在每个按键上打满所有源。 */
    const fetchSuggestions = useCallback(
        async (keyword: string): Promise<SearchSuggestion[]> => {
            const tracks = await catalogService.suggest(
                keyword,
                preferredSource ?? activeSource ?? currentSource ?? undefined,
            );
            return tracks.map((track) => ({value: track.title, desc: track.artist}));
        },
        [preferredSource, activeSource, currentSource],
    );

    const [pipActive, setPipActive] = useState(false);
    const [maximized, setMaximized] = useState(false);
    const {config} = useTheme();
    const searchBox = config.components.searchBox;

    /* 最大化状态以**真实窗口**为准：按钮、双击拖动区、系统快捷键都会改它 */
    useEffect(() => {
        if (!isTauri()) return;
        let active = true;
        let unlisten: (() => void) | undefined;

        const syncMaximized = () => {
            void windowService.isMaximized().then((maximizedValue) => {
                if (active) setMaximized(maximizedValue);
            });
        };

        /* 挂载时也读一次置顶；之后只有应用自己的 PIP/展开会改它，resize 路径不再轮询 */
        void Promise.all([
            windowService.isMaximized(),
            windowService.isAlwaysOnTop(),
        ]).then(([maximizedValue, alwaysOnTop]) => {
            if (!active) return;
            setMaximized(maximizedValue);
            setPipActive(alwaysOnTop);
        });

        void windowService.onResized(syncMaximized).then((off) => {
            unlisten = off;
            /* 订阅回来时组件已经卸载：立刻退订，别留下野监听 */
            if (!active) off();
        });

        return () => {
            active = false;
            unlisten?.();
        };
    }, []);

    /* 灯泡：明暗背景一键切换（主题市场只负责配色预设，互不重叠） */
    const toggleScheme = useCallback(() => {
        setThemeMode(scheme === 'dark' ? 'light' : 'dark');
    }, [scheme, setThemeMode]);

    const toggleCompact = useCallback(() => {
        setPipActive((prev) => {
            void windowService.setCompact(!prev);
            return !prev;
        });
    }, []);

    /* 桌面歌词：窗口可见性与 store 同步（歌词窗口自己关掉时会推事件回来） */
    const toggleDesktopLyrics = useCallback(async () => {
        const open = await windowService.toggleDesktopLyrics();
        if (open !== null) setDesktopLyricsOpen(open);
    }, [setDesktopLyricsOpen]);

    useEffect(() => {
        if (!isTauri()) return;
        let active = true;
        void windowService.desktopLyricsVisible().then((visible) => {
            if (active) setDesktopLyricsOpen(visible);
        });
        return () => {
            active = false;
        };
    }, [setDesktopLyricsOpen]);

    return (
        /*
         * data-tauri-drag-region="deep"：无边框窗口（decorations: false）的拖动区。
         * Tauri 的注入脚本按 mousedown 的路径判定——按钮 / 输入框等可点击元素会**阻断**拖动，
         * 所以搜索框与工具栏按钮照常可点，空白处与 Logo 才是拖动区。
         * 没有这个属性，无边框窗口就完全拖不动（这是一个真实报上来的 bug）。
         */
        <header
            className={[styles.titleBar, compact ? styles.titleBarCompact : '']
                .filter(Boolean)
                .join(' ')}
            data-compact={compact ? 'true' : 'false'}
            data-tauri-drag-region="deep"
        >
            <Logo compact={compact}/>

            <div className={styles.search}>
                <SearchBox
                    value={searchQuery}
                    suggestions={fetchSuggestions}
                    /* 热搜词是**演示内容**（`src/mock/search.mock.ts`）：桌面上不出现 */
                    hotWords={coreAvailable() ? [] : HOT_SEARCH_WORDS}
                    placeholder={t('search.placeholder')}
                    submitText={t('search.submit')}
                    historyKey={searchBox.historyKey}
                    maxHistory={searchBox.maxHistory}
                    debounce={searchBox.debounce}
                    onChange={setSearchQuery}
                    onSearch={(keyword) => {
                        setSearchQuery(keyword);
                        // 搜索结果独立成页，URL 可直接分享 / 刷新
                        navigate(`/search?q=${encodeURIComponent(keyword)}`);
                    }}
                />
            </div>

            <Toolbar
                scheme={scheme}
                compact={pipActive}
                windowControlsEnabled={isTauri()}
                maximized={maximized}
                onSchemeToggle={toggleScheme}
                onThemeMarketClick={() => navigate('/theme')}
                onSettingsClick={() => navigate('/setting')}
                onCompactClick={toggleCompact}
                desktopLyricsOpen={desktopLyricsOpen}
                onDesktopLyricsClick={() => void toggleDesktopLyrics()}
                onMinimizeClick={() => void windowService.minimize()}
                onMaximizeClick={() => void windowService.toggleMaximize()}
                onCloseClick={() => void windowService.close()}
            />
        </header>
    );
}

export default TitleBar;
