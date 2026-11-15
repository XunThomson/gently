import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {DiscoverDemo} from './components/DiscoverDemo';
import styles from './hot.module.css';

/**
 * 发现页（R145）。
 *
 * 原来的「热门推荐」依赖推荐数据与源侧推荐，数据质量有限且已被裁掉；
 * 现在 `/hot` 只保留**发现**：一张 Three.js 的唱片/封套场景，作为后续
 * 「播放器背景/视觉实验」的落点。手机端在 `MobileShell` 里被重定向回主页，
 * 这个页面只服务桌面端。
 */
export default function HotView() {
    const {t} = useTranslation();
    return (
        <Page title={t('page.hot.discoverTitle')} subtitle={t('page.hot.discoverSubtitle')}>
            <section className={styles.section}>
                <DiscoverDemo/>
            </section>
        </Page>
    );
}
