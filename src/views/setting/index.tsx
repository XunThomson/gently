import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {Page} from '../../components/ui/page';
import {Button} from '../../components/ui/button';
import {UnderlineRadioGroup} from '../../components/ui/radio-group';
import {BadgeCell, TextCell} from '../../components/ui/data-table';
import {SUPPORTED_LANGS} from '../../i18n';
import {getActiveMusicSource} from '../../plugins';
import {catalogService} from '../../services';
import {useActions, usePluginState, useSelect} from '../../store';
import {getThemePreset, useTheme} from '../../theme';
import type {ThemeMode} from '../../theme';
import type {SourceDisplayMode, SourceFilterStyle, TrackQuality} from '../../types';
import {QUALITIES_DESC, qualityLabelKey} from '../../utils/quality';
import {DiagnosticsCard} from './components/diagnostics-card';
import styles from './setting.module.css';

const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];
const DISPLAY_MODES: SourceDisplayMode[] = ['aggregate', 'perSource'];
const FILTER_STYLES: SourceFilterStyle[] = ['tabs', 'drawer'];

/** 设置视图：外观（明暗 / 主题市场 / 语言）、音源与音质、数据源与版本。 */
export default function SettingView() {
    const {t, i18n} = useTranslation();
    const navigate = useNavigate();
    const {config, mode, setMode, presetId} = useTheme();
    const source = getActiveMusicSource().info;
    const preset = getThemePreset(presetId);
    const appVersion = __APP_VERSION__;

    const display = useSelect((s) => s.ui.sourceDisplay);
    const filterStyle = useSelect((s) => s.ui.sourceFilterStyle);
    const preferredSource = useSelect((s) => s.ui.preferredSource);
    const preferredQuality = useSelect((s) => s.ui.preferredQuality);
    const confirmDestructive = useSelect((s) => s.ui.confirmDestructive);
    const {setSourceDisplay, setSourceFilterStyle, setPreferredSource, setPreferredQuality, setConfirmDestructive} =
        useActions().ui;
    const pluginList = usePluginState().list;

    /* 可选的优先音源：只列出已启用且已实现的音源 */
    const activeSources = catalogService
        .listActiveSources()
        .filter((item) => pluginList.some((plugin) => plugin.id === item.id && plugin.enabled));

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
                    <span className={styles.label}>{t('toolbar.themeMarket')}</span>
                    <span className={styles.value}>
                        <TextCell tone="muted">{preset.name}</TextCell>
                        <Button size="sm" variant="ghost" onClick={() => navigate('/theme')}>
                            {t('page.setting.openThemeMarket')}
                        </Button>
                    </span>
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

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.confirmDestructive')}</span>
                    <span className={styles.value}>
                        <UnderlineRadioGroup
                            name="confirm-destructive"
                            value={confirmDestructive ? 'on' : 'off'}
                            onChange={(value) => setConfirmDestructive(value === 'on')}
                            options={[
                                {value: 'on', label: t('common.confirm')},
                                {value: 'off', label: t('common.disable')},
                            ]}
                        />
                    </span>
                </div>
                <p className={styles.hint}>{t('page.setting.confirmHint')}</p>
            </section>

            {/* ---------- 音源与音质 ---------- */}
            <section className={styles.card}>
                <h2 className={styles.cardTitle}>{t('page.setting.sourceSection')}</h2>

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.sourceDisplay')}</span>
                    <UnderlineRadioGroup
                        name="source-display"
                        value={display}
                        onChange={setSourceDisplay}
                        options={DISPLAY_MODES.map((value) => ({
                            value,
                            label: t(
                                value === 'aggregate'
                                    ? 'page.setting.sourceDisplayAggregate'
                                    : 'page.setting.sourceDisplayPerSource',
                            ),
                        }))}
                    />
                </div>

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.sourceFilterStyle')}</span>
                    <UnderlineRadioGroup
                        name="source-filter-style"
                        value={filterStyle}
                        onChange={setSourceFilterStyle}
                        options={FILTER_STYLES.map((value) => ({
                            value,
                            label: t(
                                value === 'tabs'
                                    ? 'page.setting.sourceFilterTabs'
                                    : 'page.setting.sourceFilterDrawer',
                            ),
                        }))}
                    />
                </div>

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.preferredSource')}</span>
                    <UnderlineRadioGroup
                        name="preferred-source"
                        value={preferredSource ?? 'auto'}
                        onChange={(value) => setPreferredSource(value === 'auto' ? null : value)}
                        options={[
                            {value: 'auto', label: t('source.auto')},
                            ...activeSources.map((item) => ({value: item.id, label: item.name})),
                        ]}
                    />
                </div>

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.preferredQuality')}</span>
                    <UnderlineRadioGroup
                        name="preferred-quality"
                        value={preferredQuality}
                        onChange={(value) => setPreferredQuality(value as TrackQuality)}
                        options={QUALITIES_DESC.map((value) => ({
                            value,
                            label: t(qualityLabelKey(value)),
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
                        <TextCell tone="muted">
                            {t('source.count', {count: activeSources.length})}
                        </TextCell>
                    </span>
                </div>
            </section>

            <section className={styles.card}>
                <h2 className={styles.cardTitle}>{t('page.setting.about')}</h2>

                <div className={styles.field}>
                    <span className={styles.label}>{t('app.title')}</span>
                    <span className={styles.value}>
                        <TextCell tone="muted">
                            {t('page.setting.version', {version: appVersion})}
                        </TextCell>
                    </span>
                </div>

                <div className={styles.field}>
                    <span className={styles.label}>{config.meta.name}</span>
                    <span className={styles.value}>
                        <TextCell tone="muted">
                            {t('page.setting.version', {version: config.meta.version})}
                        </TextCell>
                    </span>
                </div>
            </section>

            {/* ---------- 本机核心诊断（浏览器下显示「浏览器模式」） ---------- */}
            <DiagnosticsCard />
        </Page>
    );
}
