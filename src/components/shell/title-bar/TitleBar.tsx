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

/** 联想：走曲库门面（只查当前生效音源，保证输入响应速度） */
async function fetchSuggestions(keyword: string): Promise<SearchSuggestion[]> {
    const tracks = await catalogService.searchIn(keyword);
    return tracks.map((track) => ({value: track.title, desc: track.artist}));
}

/**
 * 标题栏：品牌 + 全局搜索 + 工具栏。
 * 搜索状态集中在 store 的 ui/searchQuery，提交后跳转到「热门推荐」展示结果。
 */
export function TitleBar() {
    const {t} = useTranslation();
    const navigate = useNavigate();
    const {setSearchQuery, setThemeMode} = useActions().ui;
    const searchQuery = useSelect((s) => s.ui.searchQuery);
    const scheme = useSelect((s) => s.ui.scheme);

    const [compact, setCompact] = useState(false);
    const [maximized, setMaximized] = useState(false);
    const {config} = useTheme();
    const searchBox = config.components.searchBox;

    /* 最大化状态以**真实窗口**为准：按钮、双击拖动区、系统快捷键都会改它 */
    useEffect(() => {
        if (!isTauri()) return;
        let active = true;
        let unlisten: (() => void) | undefined;

        const sync = () => {
            void windowService.isMaximized().then((value) => {
                if (active) setMaximized(value);
            });
        };

        sync();
        void windowService.onResized(sync).then((off) => {
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
        setCompact((prev) => {
            void windowService.setCompact(!prev);
            return !prev;
        });
    }, []);

    return (
        /*
         * data-tauri-drag-region="deep"：无边框窗口（decorations: false）的拖动区。
         * Tauri 的注入脚本按 mousedown 的路径判定——按钮 / 输入框等可点击元素会**阻断**拖动，
         * 所以搜索框与工具栏按钮照常可点，空白处与 Logo 才是拖动区。
         * 没有这个属性，无边框窗口就完全拖不动（这是一个真实报上来的 bug）。
         */
        <header className={styles.titleBar} data-tauri-drag-region="deep">
            <Logo/>

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
                compact={compact}
                windowControlsEnabled={isTauri()}
                maximized={maximized}
                onSchemeToggle={toggleScheme}
                onThemeMarketClick={() => navigate('/theme')}
                onSettingsClick={() => navigate('/setting')}
                onCompactClick={toggleCompact}
                onMinimizeClick={() => void windowService.minimize()}
                onMaximizeClick={() => void windowService.toggleMaximize()}
                onCloseClick={() => void windowService.close()}
            />
        </header>
    );
}

export default TitleBar;
