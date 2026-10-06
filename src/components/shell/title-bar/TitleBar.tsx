import {useCallback, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {useActions, useSelect} from '../../../store';
import {catalogService, isTauri, windowService} from '../../../services';
import {HOT_SEARCH_WORDS} from '../../../mock/search.mock';
import {themeConfig} from '../../../theme';
import {SearchBox, type SearchSuggestion} from '../../ui/search-box';
import {Logo} from './Logo';
import {Toolbar} from './Toolbar';
import styles from './title-bar.module.css';

/** 联想：走曲库门面（实际数据源由插件决定） */
async function fetchSuggestions(keyword: string): Promise<SearchSuggestion[]> {
    const tracks = await catalogService.search(keyword);
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
    const searchBox = themeConfig.components.searchBox;

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
        <header className={styles.titleBar}>
            <Logo/>

            <div className={styles.search}>
                <SearchBox
                    value={searchQuery}
                    suggestions={fetchSuggestions}
                    hotWords={HOT_SEARCH_WORDS}
                    placeholder={t('search.placeholder')}
                    submitText={t('search.submit')}
                    historyKey={searchBox.historyKey}
                    maxHistory={searchBox.maxHistory}
                    debounce={searchBox.debounce}
                    onChange={setSearchQuery}
                    onSearch={(keyword) => {
                        setSearchQuery(keyword);
                        navigate('/hot');
                    }}
                />
            </div>

            <Toolbar
                scheme={scheme}
                compact={compact}
                windowControlsEnabled={isTauri()}
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
