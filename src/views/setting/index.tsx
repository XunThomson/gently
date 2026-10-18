import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {Page} from '../../components/ui/page';
import {Button} from '../../components/ui/button';
import {UnderlineRadioGroup} from '../../components/ui/radio-group';
import {BadgeCell, TextCell} from '../../components/ui/data-table';
import {appConfig} from '../../config/app.config';
import {SUPPORTED_LANGS} from '../../i18n';
import {catalogService} from '../../services';
import {useActions, usePluginState, useSelect} from '../../store';
import {getThemePreset, useTheme} from '../../theme';
import type {ThemeMode} from '../../theme';
import type {DownloadQualityFallback, SourceDisplayMode, SourceFilterStyle, TrackQuality} from '../../types';
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
    const preset = getThemePreset(presetId);
    const appVersion = __APP_VERSION__;

    const display = useSelect((s) => s.ui.sourceDisplay);
    const filterStyle = useSelect((s) => s.ui.sourceFilterStyle);
    const preferredSource = useSelect((s) => s.ui.preferredSource);
    const preferredQuality = useSelect((s) => s.ui.preferredQuality);
    const confirmDestructive = useSelect((s) => s.ui.confirmDestructive);
    const downloadDir = useSelect((s) => s.ui.downloadDir);
    const downloadQuality = useSelect((s) => s.ui.downloadQuality);
    const downloadQualityFallback = useSelect((s) => s.ui.downloadQualityFallback);
    const downloadMaxConcurrent = useSelect((s) => s.ui.downloadMaxConcurrent);
    const {
        setSourceDisplay,
        setSourceFilterStyle,
        setPreferredSource,
        setPreferredQuality,
        setConfirmDestructive,
        setDownloadDir,
        setDownloadQuality,
        setDownloadQualityFallback,
        setDownloadMaxConcurrent,
    } = useActions().ui;
    const pluginList = usePluginState().list;

    /* 可选的优先音源：store 的插件列表（桌面端来自核心），只取已启用的 */
    const activeSources = pluginList.filter((plugin) => plugin.enabled);
    /**
     * 当前生效的音源。**必须经服务层拿**（AGENTS 第 5 条），且返回 `null` 是正常状态：
     * 桌面上一个音源都没装时，这里以前会直接抛异常——应用没有错误边界，整页白屏。
     */
    const source = catalogService.activeSource(pluginList);

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
                        {source ? (
                            <>
                                <TextCell>{source.name}</TextCell>{' '}
                                <BadgeCell tone="accent">v{source.version}</BadgeCell>
                                <TextCell tone="muted">
                                    {t('source.count', {count: activeSources.length})}
                                </TextCell>
                            </>
                        ) : (
                            /* 一个音源都没装：如实说「还没有安装任何插件」，不显示假音源 */
                            <TextCell tone="muted">{t('page.plugin.empty')}</TextCell>
                        )}
                    </span>
                </div>
            </section>

            <section className={styles.card}>
                <h2 className={styles.cardTitle}>{t('page.setting.download')}</h2>

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.downloadDir')}</span>
                    <span className={styles.value}>
                        <input
                            className={styles.input}
                            type="text"
                            value={downloadDir}
                            placeholder={t('page.setting.downloadDirPlaceholder')}
                            aria-label={t('page.setting.downloadDir')}
                            onChange={(event) => setDownloadDir(event.target.value)}
                        />
                    </span>
                </div>
                <p className={styles.hint}>{t('page.setting.downloadDirHint')}</p>

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.maximumConcurrentDownloads')}</span>
                    <span className={styles.value}>
                        <UnderlineRadioGroup
                            name="download-concurrent"
                            value={String(downloadMaxConcurrent)}
                            onChange={(value) => setDownloadMaxConcurrent(Number(value))}
                            options={appConfig.download.maxConcurrentOptions.map((value) => ({
                                value: String(value),
                                label: String(value),
                            }))}
                        />
                    </span>
                </div>
                <p className={styles.hint}>{t('page.setting.downloadConcurrentHint')}</p>

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.defaultDownloadQuality')}</span>
                    <span className={styles.value}>
                        <UnderlineRadioGroup
                            name="download-quality"
                            value={downloadQuality}
                            onChange={(value) => setDownloadQuality(value as TrackQuality)}
                            options={QUALITIES_DESC.map((value) => ({
                                value,
                                label: t(qualityLabelKey(value)),
                            }))}
                        />
                    </span>
                </div>

                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.whenDownloadQualityIsMissing')}</span>
                    <span className={styles.value}>
                        <UnderlineRadioGroup
                            name="download-quality-fallback"
                            value={downloadQualityFallback}
                            onChange={(value) =>
                                setDownloadQualityFallback(value as DownloadQualityFallback)
                            }
                            options={[
                                {
                                    value: 'lower',
                                    label: t('page.setting.downloadLowerQualityVersion'),
                                },
                                {
                                    value: 'higher',
                                    label: t('page.setting.downloadHigherQualityVersion'),
                                },
                            ]}
                        />
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
            <DiagnosticsCard/>
        </Page>
    );
}
