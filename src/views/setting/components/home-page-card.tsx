import {useTranslation} from 'react-i18next';
import {UnderlineRadioGroup} from '../../../components/ui/radio-group';
import {MOBILE_NAV_ENTRIES} from '../../../config/mobileNav';
import {useActions, useSelect} from '../../../store';
import styles from '../setting.module.css';

/**
 * 移动端「主页」配置（仅手机形态展示）。
 *
 * 用户选的不是「首页要摆哪些模块」，而是**启动应用后先打开哪一页**——
 * 之前那版把概念做成了「搜索页空闲时的快捷入口网格」，既不是主页也不该由设置页管，
 * 已移除。这里只保留一个纯路径选择。
 *
 * 改动在下一次启动时生效：根路由 `/` 在模块加载时读取持久化值并重定向
 * （见 `router/index.tsx` 的 `mobileHomePath()`）。
 */
export function HomePageCard() {
    const {t} = useTranslation();
    const homePath = useSelect((s) => s.ui.homePath);
    const {setHomePath} = useActions().ui;

    return (
        <section className={styles.card}>
            <h2 className={styles.cardTitle}>{t('page.setting.homePage')}</h2>
            <p className={styles.hint}>{t('page.setting.homePageHint')}</p>
            <div className={styles.field}>
                <span className={styles.label}>{t('page.setting.homePageLabel')}</span>
                <span className={styles.value}>
                    <UnderlineRadioGroup
                        name="home-path"
                        value={homePath}
                        onChange={setHomePath}
                        options={MOBILE_NAV_ENTRIES.map((entry) => ({
                            value: entry.path,
                            label: t(entry.labelKey),
                        }))}
                    />
                </span>
            </div>
        </section>
    );
}

export default HomePageCard;
