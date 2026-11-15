import {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {useNavigate} from 'react-router';
import {Page} from '../../components/ui/page';
import {Button} from '../../components/ui/button';
import {BadgeCell, TextCell} from '../../components/ui/data-table';
import {appConfig} from '../../config/app.config';
import {SUPPORTED_LANGS} from '../../i18n';
import {catalogService} from '../../services';
import {useActions, usePluginState, useSelect} from '../../store';
import {getThemePreset, useTheme} from '../../theme';
import {resetPersistedUi} from '../../store/persist';
import type {ThemeMode} from '../../theme';
import type {DownloadQualityFallback, SourceDisplayMode, SourceFilterStyle, TrackQuality} from '../../types';
import {QUALITIES_DESC, qualityLabelKey} from '../../utils/quality';
import {isMobilePlatform} from '../../utils/platform';
import {AnchorNav, type AnchorItem} from './components/anchor-nav';
import {ChoiceField} from './components/choice-field';
import {ToggleField} from './components/toggle-field';
import {Section} from './components/section';
import {Field} from './components/field';
import {CacheSettings} from './components/cache-settings';
import {LyricsSettings} from './components/lyrics-settings';
import {DiagnosticsCard} from './components/diagnostics-card';
import {BackgroundCard} from './components/background-card';
import {DataDirCard} from './components/data-dir-card';
import {PetCard} from './components/pet-card';
import {WallpaperAssistant} from './components/wallpaper-assistant';
import {HomePageCard} from './components/home-page-card';
import styles from './setting.module.css';

const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];
const DISPLAY_MODES: SourceDisplayMode[] = ['aggregate', 'perSource'];
const FILTER_STYLES: SourceFilterStyle[] = ['tabs', 'drawer'];

/**
 * 设置视图：按语义分组的设置页。
 *
 * 分组顺序是固定的（外观与语言 → 播放与歌词 → 音源与音质 → 下载 → 宠物 →
 * 背景与主页 → 存储与缓存 → 关于与诊断），桌面左侧有分组锚点导航，
 * 窄窗口 / 手机退化成单列（手机上桌面专属的组整组隐藏）。
 *
 * 每个分组是一张卡片（`Section`），组内只有「行」（`Field`）；子块用
 * subTitle + 分隔线，不再套第二层卡片。
 */
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
    const lyricsAutoSearch = useSelect((s) => s.ui.lyricsAutoSearch);
    const confirmDestructive = useSelect((s) => s.ui.confirmDestructive);
    const screenDim = useSelect((s) => s.ui.screenDim);
    const downloadDir = useSelect((s) => s.ui.downloadDir);
    const downloadQuality = useSelect((s) => s.ui.downloadQuality);
    const downloadQualityFallback = useSelect((s) => s.ui.downloadQualityFallback);
    const downloadMaxConcurrent = useSelect((s) => s.ui.downloadMaxConcurrent);
    const discoverAutoPreview = useSelect((s) => s.ui.discoverAutoPreview);
    const {
        setSourceDisplay,
        setSourceFilterStyle,
        setPreferredSource,
        setPreferredQuality,
        setLyricsAutoSearch,
        setConfirmDestructive,
        setScreenDim,
        setDiscoverAutoPreview,
        setDownloadDir,
        setDownloadQuality,
        setDownloadQualityFallback,
        setDownloadMaxConcurrent,
    } = useActions().ui;
    const {requestConfirm} = useActions().dialog;
    const pluginList = usePluginState().list;

    /* 可选的优先音源：store 的插件列表（桌面端来自核心），只取已启用的 */
    const activeSources = pluginList.filter((plugin) => plugin.enabled);
    /**
     * 当前生效的音源。**必须经服务层拿**（AGENTS 第 5 条），且返回 `null` 是正常状态：
     * 桌面上一个音源都没装时，这里以前会直接抛异常——应用没有错误边界，整页白屏。
     */
    const source = catalogService.activeSource(pluginList);

    const currentLang = (i18n.resolvedLanguage ?? 'zh').slice(0, 2);
    /* 手机形态：桌面专有的设置项一律不显示（用户反馈 R121「大量 desktop 专有名词与设置项」）：
       宠物窗口、桌面歌词窗口、网页壁纸助手、诊断里的路径与「在文件夹中显示」、
       数据目录迁移——这些在手机上要么没有那个窗口，要么根本没有「路径」这个概念。 */
    const mobile = isMobilePlatform();

    /* 锚点导航与分组的 id / 标题一一对应；手机上没有导航，也不需要这份清单 */
    const anchors = useMemo<AnchorItem[]>(() => {
        const list: AnchorItem[] = [{id: 'appearance', label: t('page.setting.appearanceGroup')}];
        list.push({id: 'lyrics', label: t('page.setting.lyricsGroup')});
        if (!mobile) list.push({id: 'playback', label: t('page.setting.playbackGroup')});
        list.push(
            {id: 'source', label: t('page.setting.sourceSection')},
            {id: 'download', label: t('page.setting.download')},
        );
        if (!mobile) list.push({id: 'pet', label: t('page.setting.petSection')});
        list.push(
            {id: 'background', label: t('page.setting.backgroundGroup')},
            {id: 'storage', label: t('page.setting.storageGroup')},
            {id: 'about', label: t('page.setting.aboutGroup')},
        );
        return list;
    }, [mobile, t]);

    return (
        <Page title={t('page.setting.title')} subtitle={t('page.setting.subtitle')}>
            <div className={styles.layout}>
                {!mobile && <AnchorNav items={anchors} label={t('page.setting.sectionNav')}/>}

                <div className={styles.sections}>
                    {/* ---------- 外观与语言 ---------- */}
                    <Section
                        id="appearance"
                        title={t('page.setting.appearanceGroup')}
                        description={t('page.setting.appearanceGroupHint')}
                    >
                        <ChoiceField
                            label={t('page.setting.themeMode')}
                            value={mode}
                            onChange={(value) => setMode(value as ThemeMode)}
                            options={THEME_MODES.map((value) => ({
                                value,
                                label: t(`page.setting.theme${value[0].toUpperCase()}${value.slice(1)}`),
                            }))}
                        />

                        <Field label={t('toolbar.themeMarket')}>
                            <TextCell tone="muted">{preset.name}</TextCell>
                            <Button size="sm" variant="ghost" onClick={() => navigate('/theme')}>
                                {t('page.setting.openThemeMarket')}
                            </Button>
                        </Field>

                        <ChoiceField
                            label={t('page.setting.language')}
                            value={currentLang}
                            onChange={(value) => void i18n.changeLanguage(value)}
                            options={SUPPORTED_LANGS.map((value) => ({
                                value,
                                label: t(`language.${value}`),
                            }))}
                        />

                        <Field label={t('page.setting.screenDim')} hint={t('page.setting.screenDimHint')}>
                            <input
                                className={styles.range}
                                type="range"
                                min={0}
                                max={30}
                                step={1}
                                value={screenDim}
                                aria-label={t('page.setting.screenDim')}
                                onChange={(event) => setScreenDim(Number(event.target.value))}
                            />
                            <span className={styles.valueText}>{screenDim}%</span>
                        </Field>

                        <ToggleField
                            label={t('page.setting.confirmDestructive')}
                            hint={t('page.setting.confirmHint')}
                            checked={confirmDestructive}
                            onChange={setConfirmDestructive}
                        />

                        {/* 发现页试听：手机 8 个入口里没有「发现」页，这个开关没有意义（R126） */}
                        {!mobile && (
                            <ToggleField
                                label={t('page.setting.discoverPreview')}
                                hint={t('page.setting.discoverPreviewHint')}
                                checked={discoverAutoPreview}
                                onChange={setDiscoverAutoPreview}
                            />
                        )}
                    </Section>

                    {/* ---------- 歌词（两端都可见；自动搜索默认关）---------- */}
                    <Section
                        id="lyrics"
                        title={t('page.setting.lyricsGroup')}
                        description={t('page.setting.lyricsGroupHint')}
                    >
                        <ToggleField
                            label={t('page.setting.lyricsAutoSearch')}
                            hint={t('page.setting.lyricsAutoSearchHint')}
                            checked={lyricsAutoSearch}
                            onChange={setLyricsAutoSearch}
                        />
                    </Section>

                    {/* ---------- 播放与歌词（桌面歌词窗口，手机没有这个窗口 → 整组隐藏）---------- */}
                    {!mobile && (
                        <Section
                            id="playback"
                            title={t('page.setting.playbackGroup')}
                            description={t('page.setting.playbackGroupHint')}
                        >
                            <LyricsSettings/>
                        </Section>
                    )}

                    {/* ---------- 音源与音质 ---------- */}
                    <Section
                        id="source"
                        title={t('page.setting.sourceSection')}
                        description={t('page.setting.sourceGroupHint')}
                    >
                        <ChoiceField
                            label={t('page.setting.sourceDisplay')}
                            value={display}
                            onChange={(value) => setSourceDisplay(value as SourceDisplayMode)}
                            options={DISPLAY_MODES.map((value) => ({
                                value,
                                label: t(
                                    value === 'aggregate'
                                        ? 'page.setting.sourceDisplayAggregate'
                                        : 'page.setting.sourceDisplayPerSource',
                                ),
                            }))}
                        />

                        <ChoiceField
                            label={t('page.setting.sourceFilterStyle')}
                            value={filterStyle}
                            onChange={(value) => setSourceFilterStyle(value as SourceFilterStyle)}
                            options={FILTER_STYLES.map((value) => ({
                                value,
                                label: t(
                                    value === 'tabs'
                                        ? 'page.setting.sourceFilterTabs'
                                        : 'page.setting.sourceFilterDrawer',
                                ),
                            }))}
                        />

                        <ChoiceField
                            label={t('page.setting.preferredSource')}
                            value={preferredSource ?? 'auto'}
                            onChange={(value) => setPreferredSource(value === 'auto' ? null : value)}
                            options={[
                                {value: 'auto', label: t('source.auto')},
                                ...activeSources.map((item) => ({value: item.id, label: item.name})),
                            ]}
                        />

                        <ChoiceField
                            label={t('page.setting.preferredQuality')}
                            value={preferredQuality}
                            onChange={(value) => setPreferredQuality(value as TrackQuality)}
                            options={QUALITIES_DESC.map((value) => ({
                                value,
                                label: t(qualityLabelKey(value)),
                            }))}
                        />

                        <Field label={t('page.setting.activeSource')}>
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
                        </Field>
                    </Section>

                    {/* ---------- 下载 ---------- */}
                    <Section
                        id="download"
                        title={t('page.setting.download')}
                        description={t('page.setting.downloadGroupHint')}
                    >
                        {/* 手机形态没有「下载目录」可填：如实说明文件落在应用私有目录（R130） */}
                        {mobile && <p className={styles.hint}>{t('page.setting.downloadDirMobileHint')}</p>}

                        {/* 下载目录是一条**本机路径**：手机上既没有可粘贴的绝对路径，也没有「在文件夹中显示」，
                            所以整块不显示（文件落在应用私有目录，由系统管理） */}
                        {!mobile && (
                            <Field label={t('page.setting.downloadDir')} hint={t('page.setting.downloadDirHint')}>
                                <input
                                    className={styles.input}
                                    type="text"
                                    value={downloadDir}
                                    placeholder={t('page.setting.downloadDirPlaceholder')}
                                    aria-label={t('page.setting.downloadDir')}
                                    onChange={(event) => setDownloadDir(event.target.value)}
                                />
                            </Field>
                        )}

                        <ChoiceField
                            label={t('page.setting.maximumConcurrentDownloads')}
                            hint={t('page.setting.downloadConcurrentHint')}
                            value={String(downloadMaxConcurrent)}
                            onChange={(value) => setDownloadMaxConcurrent(Number(value))}
                            options={appConfig.download.maxConcurrentOptions.map((value) => ({
                                value: String(value),
                                label: String(value),
                            }))}
                        />

                        <ChoiceField
                            label={t('page.setting.defaultDownloadQuality')}
                            value={downloadQuality}
                            onChange={(value) => setDownloadQuality(value as TrackQuality)}
                            options={QUALITIES_DESC.map((value) => ({
                                value,
                                label: t(qualityLabelKey(value)),
                            }))}
                        />

                        <ChoiceField
                            label={t('page.setting.whenDownloadQualityIsMissing')}
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
                    </Section>

                    {/* ---------- 宠物（Beta 1.0）：独立置顶窗口 + 独立引擎 pet-core，默认关 ----------
                        手机上还没有宠物渲染器（见 ANDROID-PLAN），所以整组隐藏，不给假入口 */}
                    {!mobile && (
                        <Section
                            id="pet"
                            title={t('page.setting.petSection')}
                            description={t('page.setting.petGroupHint')}
                        >
                            <PetCard/>
                        </Section>
                    )}

                    {/* ---------- 背景与主页 ----------
                        背景卡桌面 / 手机都有；壁纸助手写的是本机文件（桌面）；主页卡只在手机 */}
                    <Section
                        id="background"
                        title={t('page.setting.backgroundGroup')}
                        description={t('page.setting.backgroundGroupHint')}
                    >
                        <BackgroundCard/>
                        <div className={styles.blockDivider}/>
                        {mobile ? <HomePageCard/> : <WallpaperAssistant/>}
                    </Section>

                    {/* ---------- 存储与缓存 ---------- */}
                    <Section
                        id="storage"
                        title={t('page.setting.storageGroup')}
                        description={t('page.setting.storageGroupHint')}
                    >
                        <CacheSettings/>
                        <div className={styles.blockDivider}/>
                        {/* 数据目录：默认在用户目录，可迁到别的盘（便携版默认跟着 exe 走）——
                            手机上由系统分配、不能在应用内迁移，所以只显示一句说明 */}
                        <DataDirCard mobile={mobile}/>
                    </Section>

                    {/* ---------- 关于与诊断（危险操作放最后一组） ---------- */}
                    <Section
                        id="about"
                        title={t('page.setting.aboutGroup')}
                        description={t('page.setting.aboutGroupHint')}
                    >
                        <Field label={t('app.title')}>
                            <TextCell tone="muted">
                                {t('page.setting.version', {version: appVersion})}
                            </TextCell>
                        </Field>

                        <Field label={config.meta.name}>
                            <TextCell tone="muted">
                                {t('page.setting.version', {version: config.meta.version})}
                            </TextCell>
                        </Field>

                        {/* 本机核心诊断（浏览器下显示「浏览器模式」）——
                            诊断里有数据目录/日志目录路径与「在文件夹中显示」，手机上没有意义 */}
                        {!mobile && (
                            <>
                                <div className={styles.blockDivider}/>
                                <DiagnosticsCard/>
                            </>
                        )}

                        {/* 恢复默认设置：只清 UI 偏好（`gently:ui`），不动曲库 / 插件 / 下载 / 凭据；二次确认后重载 */}
                        <div className={styles.blockDivider}/>
                        <h3 className={styles.subTitle}>{t('page.setting.resetSection')}</h3>
                        <p className={styles.hint}>{t('page.setting.resetHint')}</p>
                        <div className={styles.actionRow}>
                            <Button
                                size="sm"
                                variant="danger"
                                onClick={() =>
                                    requestConfirm({
                                        titleKey: 'page.setting.resetConfirmTitle',
                                        descKey: 'page.setting.resetConfirmDesc',
                                        tone: 'danger',
                                        onConfirm: () => {
                                            resetPersistedUi();
                                            window.location.reload();
                                        },
                                    })
                                }
                            >
                                {t('page.setting.resetSettings')}
                            </Button>
                        </div>
                    </Section>
                </div>
            </div>
        </Page>
    );
}
