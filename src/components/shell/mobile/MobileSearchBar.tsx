import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate, useSearchParams} from 'react-router';
import {useTheme} from '../../../theme';
import {SearchBox} from '../../ui/search-box';
import styles from './MobileShell.module.css';

/**
 * 手机端的搜索框。
 *
 * 桌面的搜索框长在标题栏里（`TitleBar`）；手机没有标题栏，搜索又是第一个 tab，
 * 所以这里把它单独放在内容区上方——**只在 `/search` 下出现**，
 * 其它 tab 不占这一行高度。
 *
 * 搜索历史 / 防抖这些参数与桌面**同源**（`theme.config.json` 的 `searchBox` 段），
 * 不另起一套偏好。
 */
export function MobileSearchBar() {
    const {t} = useTranslation();
    const {config} = useTheme();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const [value, setValue] = useState(params.get('q') ?? '');
    const box = config.components.searchBox;

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
                onSearch={(keyword) => {
                    setValue(keyword);
                    navigate(`/search?q=${encodeURIComponent(keyword)}`);
                }}
            />
        </div>
    );
}

export default MobileSearchBar;
