import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate, useSearchParams} from 'react-router';
import {useTheme} from '../../../theme';
import {SearchBox} from '../../ui/search-box';
import styles from './MobileShell.module.css';

/**
 * 手机端的搜索框。
 *
 * 桌面的搜索框长在标题栏里（`TitleBar`）；手机没有标题栏，搜索又是 home，
 * 所以这里把它单独放在内容区上方——**只在 `/search` 下出现**，其它页面不占这一行高度。
 *
 * 两个必须做对的细节：
 * 1. **输入值跟 URL 里的 `q` 同步**（返回键把 `?q=` 弹掉时，框里不该还留着上一次的关键词，
 *    否则会出现「框里有词、列表却是空的」这种自相矛盾的界面）；
 * 2. 提交搜索用 `replace`：手机上搜索是 home，反复搜索不该在历史里堆一串 `/search?q=…`，
 *    否则用户按一次返回就被弹回上一个关键词。
 *
 * 搜索历史 / 防抖这些参数与桌面**同源**（`theme.config.json` 的 `searchBox` 段）。
 */
export function MobileSearchBar() {
    const {t} = useTranslation();
    const {config} = useTheme();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const keyword = params.get('q') ?? '';
    const [value, setValue] = useState(keyword);
    const box = config.components.searchBox;

    /* URL 是唯一权威：外部导航（返回键 / 抽屉跳转）改了 q，输入框跟着走 */
    useEffect(() => {
        setValue(keyword);
    }, [keyword]);

    return (
        <div className={styles.searchRow}>
            <SearchBox
                value={value}
                placeholder={t('search.placeholder')}
                submitText={t('search.submit')}
                historyKey={box.historyKey}
                maxHistory={box.maxHistory}
                debounce={box.debounce}
                onChange={setValue}
                onSearch={(next) => {
                    const trimmed = next.trim();
                    setValue(trimmed);
                    navigate(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : '/search', {replace: true});
                }}
            />
        </div>
    );
}

export default MobileSearchBar;
