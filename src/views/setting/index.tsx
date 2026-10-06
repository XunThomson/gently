import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {UnderlineRadioGroup} from '../../components/ui/radio-group';
import {BadgeCell, TextCell} from '../../components/ui/data-table';
import {SUPPORTED_LANGS} from '../../i18n';
import {getActiveMusicSource} from '../../plugins';
import {useTheme} from '../../theme';
import type {ThemeMode} from '../../theme';
import styles from './setting.module.css';

const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];

/** 设置视图：外观（主题模式 / 语言）与数据源信息。 */
export default function SettingView() {
    const {t, i18n} = useTranslation();
    const {config, mode, setMode} = useTheme();
    const source = getActiveMusicSource().info;

    const currentLang = (i18n.resolvedLanguage ?? 'zh').slice(0, 2);

    return (
        <Page title={t('page.setting.title')} subtitle={t('page.setting.subtitle')}>
            <section className={styles.card}>
                <h2 className={styles.cardTitle}>{t('page.setting.appearance')}</h2>

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.themeMode')}</span>
                    <UnderlineRadioGroup
                        name="theme-mode"
                        value={mode}
                        onChange={setMode}
                        options={THEME_MODES.map((value) => ({
                            value,
                            label: t(`page.setting.theme${value[0].toUpperCase()}${value.slice(1)}`),
                        }))}
                    />
                </div>

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.language')}</span>
                    <UnderlineRadioGroup
                        name="language"
                        value={currentLang}
                        onChange={(value) => void i18n.changeLanguage(value)}
                        options={SUPPORTED_LANGS.map((value) => ({
                            value,
                            label: t(`language.${value}`),
                        }))}
                    />
                </div>
            </section>

            <section className={styles.card}>
                <h2 className={styles.cardTitle}>{t('page.setting.dataSource')}</h2>

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.activeSource')}</span>
                    <span className={styles.value}>
                        <TextCell>{source.name}</TextCell>{' '}
                        <BadgeCell tone="accent">v{source.version}</BadgeCell>
                    </span>
                </div>
            </section>

            <section className={styles.card}>
                <h2 className={styles.cardTitle}>{t('page.setting.about')}</h2>

                <div className={styles.field}>
                    <span className={styles.label}>{t('app.title')}</span>
                    <span className={styles.value}>
                        <TextCell tone="muted">
                            {t('page.setting.version', {version: config.meta.version})}
                        </TextCell>
                    </span>
                </div>
            </section>
        </Page>
    );
}
