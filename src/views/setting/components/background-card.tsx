import {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {appConfig} from '../../../config/app.config';
import {Button} from '../../../components/ui/button';
import {UnderlineRadioGroup} from '../../../components/ui/radio-group';
import {useConfirm} from '../../../hooks/useConfirm';
import {backgroundService} from '../../../services';
import {useActions, useSelect} from '../../../store';
import {useTheme} from '../../../theme';
import {formatBytes} from '../../../utils/helpers';
import {createBackgroundPreset} from '../../../utils/backgroundSettings';
import {parseExternalBackgroundPreset, exportExternalBackgroundPreset} from '../../../utils/backgroundPreset';
import styles from '../setting.module.css';
import {isMobilePlatform} from '../../../utils/platform';

/**
 * 设置页「动态背景」卡片（P1：本地视频 / 静态单文件网页 + 展示参数预设）。
 *
 * 素材不经过核心：用户通过 WebView 的文件选择器选本地文件，服务层校验后
 * 存 IndexedDB；localStorage 只保存元数据/参数/预设。这样不需要新增文件系统权限、
 * 也不引入 Wallpaper Engine `.pkg` 解析或外部二进制。
 *
 * 网页只接受静态 HTML/CSS：脚本和外链在 iframe sandbox + CSP 下不会执行，
 * 带 JS / 多文件的 Web 壁纸需要独立 WebView + 导航拦截，见 docs/GOTCHAS.md #14。
 */
export function BackgroundCard() {
    const {t} = useTranslation();
    const {config} = useTheme();
    const background = useSelect((state) => state.ui.background);
    const {
        setBackgroundEnabled,
        setBackgroundKind,
        setBackgroundPlayWhenReducedMotion,
        setBackgroundAsset,
        setBackgroundWeb,
        setBackgroundOptions,
        saveBackgroundPreset,
        applyBackgroundPreset,
        renameBackgroundPreset,
        removeBackgroundPreset,
        addBackgroundPreset,
        resetBackground,
    } = useActions().ui;
    const confirm = useConfirm();

    const fileRef = useRef<HTMLInputElement>(null);
    const webRef = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [missing, setMissing] = useState(false);
    const [presetName, setPresetName] = useState('');
    const [presetJson, setPresetJson] = useState('');
    const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
    const [editingPresetName, setEditingPresetName] = useState('');

    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(null), 4000);
        return () => window.clearTimeout(timer);
    }, [notice]);

    /* 元数据还在、素材丢了（清过站点数据）时明确提示，而不是静默回到内置背景 */
    useEffect(() => {
        let active = true;
        if (background.kind === 'web') {
            if (!background.web) {
                setMissing(false);
                return;
            }
            void backgroundService.hasWeb(background.web.id).then((exists) => {
                if (active) setMissing(!exists);
            });
        } else if (!background.asset) {
            setMissing(false);
            return;
        } else {
            void backgroundService.has(background.asset.id).then((exists) => {
                if (active) setMissing(!exists);
            });
        }
        return () => {
            active = false;
        };
    }, [background.kind, background.asset?.id, background.web?.id]);

    const importFile = async (file: File | undefined) => {
        if (!file) return;
        setError(null);
        setNotice(null);
        setBusy(true);
        const previousId = background.asset?.id ?? null;
        const result = await backgroundService.save(file);
        setBusy(false);
        if (!result.ok) {
            const key = {
                unsupported: 'page.background.errorUnsupported',
                empty: 'page.background.errorEmpty',
                'too-large': 'page.background.errorTooLarge',
                'unsupported-type': 'page.background.errorType',
                storage: 'page.background.errorStorage',
            }[result.reason];
            setError(t(key, {mb: Math.round(appConfig.background.maxVideoBytes / 1024 / 1024)}));
            return;
        }
        setBackgroundAsset(result.asset);
        if (previousId && previousId !== result.asset.id) {
            void backgroundService.remove(previousId);
        }
        setNotice(t('page.background.imported', {name: result.asset.name}));
    };

    const importWebFile = async (file: File) => {
        setError(null);
        setNotice(null);
        setBusy(true);
        const previousId = background.web?.id ?? null;
        const result = await backgroundService.saveWeb(file);
        setBusy(false);
        if (!result.ok) {
            const key = {
                unsupported: 'page.background.errorUnsupported',
                empty: 'page.background.errorEmpty',
                'too-large': 'page.background.errorWebTooLarge',
                'unsupported-type': 'page.background.errorWebType',
                storage: 'page.background.errorStorage',
            }[result.reason];
            setError(
                t(key, {
                    mb: Math.round(appConfig.background.maxWebBytes / 1024 / 1024),
                }),
            );
            return;
        }
        setBackgroundWeb(result.web);
        if (previousId && previousId !== result.web.id) {
            void backgroundService.removeWeb(previousId);
        }
        setNotice(t('page.background.webImported', {name: result.web.name}));
    };

    const confirmWebImport = (file: File | undefined) => {
        if (!file) return;
        confirm({
            titleKey: 'page.background.webConfirmTitle',
            descKey: 'page.background.webConfirmDesc',
            descParams: {name: file.name},
            tone: 'danger',
            onConfirm: () => {
                void importWebFile(file);
            },
        });
    };

    const reset = () => {
        confirm({
            titleKey: 'page.background.resetTitle',
            descKey: 'page.background.resetDesc',
            tone: 'danger',
            onConfirm: () => {
                const currentVideo = background.asset?.id ?? null;
                const currentWeb = background.web?.id ?? null;
                resetBackground();
                if (currentVideo) void backgroundService.remove(currentVideo);
                if (currentWeb) void backgroundService.removeWeb(currentWeb);
                setError(null);
                setNotice(t('page.background.resetDone'));
            },
        });
    };

    const removePreset = (id: string, name: string) => {
        confirm({
            titleKey: 'page.background.presetDeleteTitle',
            descKey: 'page.background.presetDeleteDesc',
            descParams: {name},
            tone: 'danger',
            onConfirm: () => removeBackgroundPreset(id),
        });
    };

    const savePreset = () => {
        const name = presetName.trim();
        if (!name) return;
        saveBackgroundPreset(name);
        setPresetName('');
        setNotice(t('page.background.presetSaved', {name}));
    };

    const saveRename = () => {
        if (!editingPresetId) return;
        renameBackgroundPreset(editingPresetId, editingPresetName);
        setEditingPresetId(null);
        setEditingPresetName('');
    };

    const exportPreset = () => {
        setPresetJson(
            exportExternalBackgroundPreset(
                presetName.trim() || t('page.background.presetFallbackName'),
                background.options,
                {opacity, blurPx, contentOpacity, contentBlurPx, drawerOpacity, drawerBlurPx},
            ),
        );
        setError(null);
        setNotice(t('page.background.presetExported'));
    };

    const importPreset = () => {
        const parsed = parseExternalBackgroundPreset(presetJson);
        if (!parsed.ok) {
            setError(
                t(
                    parsed.reason === 'invalid'
                        ? 'page.background.presetInvalid'
                        : 'page.background.presetNoMapped',
                ),
            );
            return;
        }
        const preset = createBackgroundPreset(
            parsed.preset.name || t('page.background.presetFallbackName'),
            parsed.preset.options,
            parsed.preset.unmapped,
        );
        addBackgroundPreset(preset);
        setPresetJson('');
        setError(null);
        setNotice(
            t('page.background.presetImported', {
                name: preset.name,
                mapped: parsed.preset.mappedCount,
                unmapped: parsed.preset.unmapped.length,
            }),
        );
    };

    const backgroundConfig = config.components.background;
    const opacity = background.options.opacity ?? backgroundConfig.opacity;
    const blurPx = background.options.blurPx ?? backgroundConfig.blurPx;
    const contentOpacity =
        background.options.contentOpacity ?? backgroundConfig.contentOpacity;
    const contentBlurPx =
        background.options.contentBlurPx ?? backgroundConfig.surfaceBlurPx;
    const drawerOpacity =
        background.options.drawerOpacity ?? backgroundConfig.drawerOpacity;
    const drawerBlurPx =
        background.options.drawerBlurPx ?? backgroundConfig.drawerBlurPx;
    const reduceMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    return (
        <section className={styles.card}>
            <div className={styles.cacheHeader}>
                <h2 className={styles.cardTitle}>{t('page.background.title')}</h2>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                        (background.kind === 'web' ? webRef : fileRef).current?.click()
                    }
                >
                    {background.kind === 'web'
                        ? background.web
                            ? t('page.background.replaceWeb')
                            : t('page.background.importWeb')
                        : background.asset
                            ? t('page.background.replace')
                            : t('page.background.import')}
                </Button>
            </div>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.kind')}</span>
                <span className={styles.value}>
                    <UnderlineRadioGroup
                        name="background-kind"
                        value={background.kind}
                        onChange={(value) =>
                            setBackgroundKind(value === 'web' ? 'web' : 'video')
                        }
                        options={
                            /* 网页背景 = 单个 HTML 塞进 iframe：桌面端的玩法；
                               手机上素材难准备、还白白吃内存，手机形态只留视频（R128） */
                            isMobilePlatform()
                                ? [{value: 'video', label: t('page.background.kindVideo')}]
                                : [
                                      {value: 'video', label: t('page.background.kindVideo')},
                                      {value: 'web', label: t('page.background.kindWeb')},
                                  ]
                        }
                    />
                </span>
            </div>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.enabled')}</span>
                <span className={styles.value}>
                    <UnderlineRadioGroup
                        name="background-enabled"
                        value={background.enabled ? 'on' : 'off'}
                        onChange={(value) => setBackgroundEnabled(value === 'on')}
                        options={[
                            {value: 'on', label: t('page.background.on')},
                            {value: 'off', label: t('page.background.off')},
                        ]}
                    />
                </span>
            </div>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.reducedMotionSetting')}</span>
                <span className={styles.value}>
                    <UnderlineRadioGroup
                        name="background-reduced-motion"
                        value={background.playWhenReducedMotion ? 'play' : 'respect'}
                        onChange={(value) =>
                            setBackgroundPlayWhenReducedMotion(value === 'play')
                        }
                        options={[
                            {
                                value: 'respect',
                                label: t('page.background.reducedMotionRespect'),
                            },
                            {value: 'play', label: t('page.background.reducedMotionPlay')},
                        ]}
                    />
                </span>
            </div>
            <p className={styles.hint}>{t('page.background.reducedMotionHint')}</p>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.current')}</span>
                <span className={styles.value}>
                    {background.kind === 'web' ? (
                        background.web ? (
                            <span className={styles.path}>
                                {background.web.name} · {formatBytes(background.web.size)}
                            </span>
                        ) : (
                            <span className={styles.hint}>{t('page.background.none')}</span>
                        )
                    ) : background.asset ? (
                        <span className={styles.path}>
                            {background.asset.name} · {formatBytes(background.asset.size)}
                        </span>
                    ) : (
                        <span className={styles.hint}>{t('page.background.none')}</span>
                    )}
                    {(background.kind === 'web' ? background.web : background.asset) && (
                        <Button size="sm" variant="ghost" onClick={reset}>
                            {t('page.background.reset')}
                        </Button>
                    )}
                </span>
            </div>
            {missing && <p className={styles.notice}>{t('page.background.missing')}</p>}
            {(background.kind === 'web' ? background.web : background.asset) &&
                reduceMotion &&
                !background.playWhenReducedMotion && (
                    <p className={styles.hint}>{t('page.background.reducedMotion')}</p>
                )}
            <p className={styles.hint}>
                {background.kind === 'web'
                    ? t('page.background.webHint')
                    : t('page.background.hint')}
            </p>

            {background.kind === 'video' && (
                <>
                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.background.fit')}</span>
                        <UnderlineRadioGroup
                            name="background-fit"
                            value={background.options.fit}
                            onChange={(value) =>
                                setBackgroundOptions({fit: value === 'contain' ? 'contain' : 'cover'})
                            }
                            options={[
                                {value: 'cover', label: t('page.background.fitCover')},
                                {value: 'contain', label: t('page.background.fitContain')},
                            ]}
                        />
                    </div>

                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.background.rate')}</span>
                        <span className={styles.value}>
                            <input
                                type="range"
                                className={styles.range}
                                min={appConfig.background.minPlaybackRate}
                                max={appConfig.background.maxPlaybackRate}
                                step={0.25}
                                value={background.options.playbackRate}
                                aria-label={t('page.background.rate')}
                                onChange={(event) =>
                                    setBackgroundOptions({
                                        playbackRate: Number(event.target.value),
                                    })
                                }
                            />
                            <span className={styles.valueText}>
                                ×{background.options.playbackRate.toFixed(2)}
                            </span>
                        </span>
                    </div>
                </>
            )}

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.opacity')}</span>
                <span className={styles.value}>
                    <input
                        type="range"
                        className={styles.range}
                        min={0}
                        max={100}
                        step={5}
                        value={Math.round(opacity * 100)}
                        aria-label={t('page.background.opacity')}
                        onChange={(event) =>
                            setBackgroundOptions({opacity: Number(event.target.value) / 100})
                        }
                    />
                    <span className={styles.valueText}>{Math.round(opacity * 100)}%</span>
                </span>
            </div>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.contentOpacity')}</span>
                <span className={styles.value}>
                    <input
                        type="range"
                        className={styles.range}
                        min={Math.round(appConfig.background.minContentOpacity * 100)}
                        max={100}
                        step={1}
                        value={Math.round(contentOpacity * 100)}
                        aria-label={t('page.background.contentOpacity')}
                        onChange={(event) =>
                            setBackgroundOptions({
                                contentOpacity: Number(event.target.value) / 100,
                            })
                        }
                    />
                    <span className={styles.valueText}>{Math.round(contentOpacity * 100)}%</span>
                </span>
            </div>
            <p className={styles.hint}>{t('page.background.contentOpacityHint')}</p>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.contentBlur')}</span>
                <span className={styles.value}>
                    <input
                        type="range"
                        className={styles.range}
                        min={0}
                        max={appConfig.background.maxBlurPx}
                        step={1}
                        value={Math.round(contentBlurPx)}
                        aria-label={t('page.background.contentBlur')}
                        onChange={(event) =>
                            setBackgroundOptions({
                                contentBlurPx: Number(event.target.value),
                            })
                        }
                    />
                    <span className={styles.valueText}>{Math.round(contentBlurPx)}px</span>
                </span>
            </div>
            <p className={styles.hint}>{t('page.background.contentBlurHint')}</p>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.drawerOpacity')}</span>
                <span className={styles.value}>
                    <input
                        type="range"
                        className={styles.range}
                        min={Math.round(appConfig.background.minDrawerOpacity * 100)}
                        max={100}
                        step={1}
                        value={Math.round(drawerOpacity * 100)}
                        aria-label={t('page.background.drawerOpacity')}
                        onChange={(event) =>
                            setBackgroundOptions({
                                drawerOpacity: Number(event.target.value) / 100,
                            })
                        }
                    />
                    <span className={styles.valueText}>{Math.round(drawerOpacity * 100)}%</span>
                </span>
            </div>
            <p className={styles.hint}>{t('page.background.drawerOpacityHint')}</p>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.drawerBlur')}</span>
                <span className={styles.value}>
                    <input
                        type="range"
                        className={styles.range}
                        min={0}
                        max={appConfig.background.maxBlurPx}
                        step={1}
                        value={Math.round(drawerBlurPx)}
                        aria-label={t('page.background.drawerBlur')}
                        onChange={(event) =>
                            setBackgroundOptions({
                                drawerBlurPx: Number(event.target.value),
                            })
                        }
                    />
                    <span className={styles.valueText}>{Math.round(drawerBlurPx)}px</span>
                </span>
            </div>
            <p className={styles.hint}>{t('page.background.drawerBlurHint')}</p>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.blur')}</span>
                <span className={styles.value}>
                    <input
                        type="range"
                        className={styles.range}
                        min={0}
                        max={appConfig.background.maxBlurPx}
                        step={1}
                        value={Math.round(blurPx)}
                        aria-label={t('page.background.blur')}
                        onChange={(event) =>
                            setBackgroundOptions({blurPx: Number(event.target.value)})
                        }
                    />
                    <span className={styles.valueText}>{Math.round(blurPx)}px</span>
                </span>
            </div>

            <div className={styles.blockDivider}/>

            <h3 className={styles.subTitle}>{t('page.background.presetTitle')}</h3>
            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.presetName')}</span>
                <span className={styles.value}>
                    <input
                        className={styles.input}
                        value={presetName}
                        placeholder={t('page.background.presetNamePlaceholder')}
                        onChange={(event) => setPresetName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') savePreset();
                        }}
                    />
                    <Button size="sm" disabled={!presetName.trim()} onClick={savePreset}>
                        {t('page.background.presetSave')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={exportPreset}>
                        {t('page.background.presetExport')}
                    </Button>
                </span>
            </div>
            <p className={styles.hint}>{t('page.background.presetExportHint')}</p>

            {background.presets.length === 0 ? (
                <p className={styles.hint}>{t('page.background.presetEmpty')}</p>
            ) : (
                <ul className={styles.presetList}>
                    {background.presets.map((preset) => (
                        <li key={preset.id} className={styles.presetRow}>
                            {editingPresetId === preset.id ? (
                                <>
                                    <input
                                        className={styles.input}
                                        value={editingPresetName}
                                        autoFocus
                                        onChange={(event) => setEditingPresetName(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') saveRename();
                                            if (event.key === 'Escape') setEditingPresetId(null);
                                        }}
                                    />
                                    <span className={styles.value}>
                                        <Button
                                            size="sm"
                                            disabled={!editingPresetName.trim()}
                                            onClick={saveRename}
                                        >
                                            {t('common.save')}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => setEditingPresetId(null)}
                                        >
                                            {t('common.cancel')}
                                        </Button>
                                    </span>
                                </>
                            ) : (
                                <>
                                    <span className={styles.presetName}>
                                        {preset.name}
                                        {preset.id === background.activePresetId && (
                                            <span className={styles.presetActive}>
                                                {t('page.background.presetActive')}
                                            </span>
                                        )}
                                        {preset.unmapped.length > 0 && (
                                            <span className={styles.presetMeta}>
                                                {t('page.background.presetUnmapped', {
                                                    count: preset.unmapped.length,
                                                })}
                                            </span>
                                        )}
                                    </span>
                                    <span className={styles.value}>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => {
                                                setEditingPresetId(preset.id);
                                                setEditingPresetName(preset.name);
                                            }}
                                        >
                                            {t('page.background.presetRename')}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => applyBackgroundPreset(preset.id)}
                                        >
                                            {t('page.background.presetApply')}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => removePreset(preset.id, preset.name)}
                                        >
                                            {t('page.background.presetDelete')}
                                        </Button>
                                    </span>
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.presetImport')}</span>
                <span className={styles.hint}>{t('page.background.presetImportHint')}</span>
            </div>
            <textarea
                className={styles.textarea}
                value={presetJson}
                placeholder={t('page.background.presetPlaceholder')}
                onChange={(event) => setPresetJson(event.target.value)}
            />
            <div className={styles.cacheActions}>
                <Button size="sm" disabled={!presetJson.trim()} onClick={importPreset}>
                    {t('page.background.presetImportAction')}
                </Button>
            </div>

            {error && <p className={styles.error}>{error}</p>}
            {notice && <p className={styles.notice}>{notice}</p>}

            <input
                ref={fileRef}
                type="file"
                accept="video/mp4,video/webm,video/ogg,video/x-m4v,.mp4,.webm,.m4v,.ogv,.ogg"
                hidden
                onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    void importFile(file);
                }}
            />
            <input
                ref={webRef}
                type="file"
                accept=".html,.htm,.xhtml,text/html,application/xhtml+xml"
                hidden
                onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    confirmWebImport(file);
                }}
            />
        </section>
    );
}

export default BackgroundCard;
