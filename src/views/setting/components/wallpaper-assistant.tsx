import {useEffect, useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {appConfig} from '../../../config/app.config';
import {Button} from '../../../components/ui/button';
import {useConfirm} from '../../../hooks/useConfirm';
import {backgroundService} from '../../../services';
import {useActions} from '../../../store';
import {formatBytes} from '../../../utils/helpers';
import {
    inlineWebWallpaper,
    MAX_INLINE_FILES,
    MAX_INLINE_INPUT_BYTES,
    normalizeWebPath,
    type InlineWebResult,
} from '../../../utils/wallpaperInline';
import styles from '../setting.module.css';

/**
 * 壁纸准备助手：把用户自己选中的静态网页目录内联成一个 HTML，
 * 或说明 WE 视频/Scene/Share JSON 的可做边界。
 *
 * 这里**没有新增文件系统命令**：目录由用户通过 `<input webkitdirectory>` 显式选择，
 * 文件只在本次渲染内读取，不写盘；打包结果要么下载，要么交给
 * `backgroundService.saveWeb` 存进 IndexedDB。
 */
export function WallpaperAssistant() {
    const {t} = useTranslation();
    const confirm = useConfirm();
    const {setBackgroundWeb, setBackgroundKind, setBackgroundEnabled} = useActions().ui;

    const dirRef = useRef<HTMLInputElement>(null);
    const [files, setFiles] = useState<File[]>([]);
    const [entries, setEntries] = useState<string[]>([]);
    const [entryPath, setEntryPath] = useState('');
    const [result, setResult] = useState<InlineWebResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    /* webkitdirectory 不是 React 的受控属性，挂载后显式设置 */
    useEffect(() => {
        const input = dirRef.current;
        if (!input) return;
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
    }, []);

    useEffect(() => {
        if (!notice) return;
        const timer = window.setTimeout(() => setNotice(null), 5000);
        return () => window.clearTimeout(timer);
    }, [notice]);

    const totalBytes = useMemo(
        () => files.reduce((sum, file) => sum + file.size, 0),
        [files],
    );

    const errorText = (code: string): string => {
        switch (code) {
            case 'too-many-files':
                return t('page.background.assistantErrorTooMany', {count: MAX_INLINE_FILES});
            case 'input-too-large':
                return t('page.background.assistantErrorInputLarge', {
                    mb: Math.round(MAX_INLINE_INPUT_BYTES / 1024 / 1024),
                });
            case 'no-html':
                return t('page.background.assistantErrorNoHtml');
            case 'output-too-large':
                return t('page.background.assistantErrorOutputLarge', {
                    mb: Math.round(appConfig.background.maxWebBytes / 1024 / 1024),
                });
            case 'no-dom':
            case 'no-files':
            default:
                return t('page.background.assistantErrorBuild');
        }
    };

    const pickDirectory = () => {
        setError(null);
        setResult(null);
        dirRef.current?.click();
    };

    const handleFiles = (list: FileList | null) => {
        const selected = list ? [...list] : [];
        setError(null);
        setResult(null);
        setNotice(null);
        if (selected.length === 0) return;
        if (selected.length > MAX_INLINE_FILES) {
            setError(errorText('too-many-files'));
            return;
        }
        if (selected.reduce((sum, file) => sum + file.size, 0) > MAX_INLINE_INPUT_BYTES) {
            setError(errorText('input-too-large'));
            return;
        }

        const htmls = selected
            .map((file) => {
                const relative =
                    (file as File & {webkitRelativePath?: string}).webkitRelativePath || file.name;
                return normalizeWebPath(relative);
            })
            .filter((path): path is string => !!path && /\.(?:html?|xhtml)$/i.test(path));

        if (htmls.length === 0) {
            setFiles([]);
            setEntries([]);
            setEntryPath('');
            setError(errorText('no-html'));
            return;
        }

        const preferred =
            htmls.find((path) => /(^|\/)index\.html?$/i.test(path)) ?? htmls[0];
        setFiles(selected);
        setEntries(htmls);
        setEntryPath(preferred);
    };

    const build = async () => {
        if (files.length === 0 || !entryPath) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        setResult(null);
        try {
            const output = await inlineWebWallpaper(files, entryPath);
            setResult(output);
        } catch (err) {
            const code = err instanceof Error ? err.message : '';
            setError(errorText(code || 'no-files'));
        } finally {
            setBusy(false);
        }
    };

    const outputName = () => {
        const base = entryPath.replace(/^.*\//, '').replace(/\.(?:html?|xhtml)$/i, '');
        return `${(base || 'wallpaper').slice(0, 80)}-inline.html`;
    };

    const apply = () => {
        if (!result) return;
        const name = outputName();
        confirm({
            titleKey: 'page.background.assistantConfirmTitle',
            descKey: 'page.background.assistantConfirmDesc',
            descParams: {name},
            tone: 'danger',
            onConfirm: () => {
                void (async () => {
                    setBusy(true);
                    setError(null);
                    setNotice(null);
                    const saved = await backgroundService.saveWeb(
                        new File([result.html], name, {type: 'text/html'}),
                    );
                    setBusy(false);
                    if (!saved.ok) {
                        const key = {
                            unsupported: 'page.background.errorUnsupported',
                            empty: 'page.background.errorEmpty',
                            'too-large': 'page.background.errorWebTooLarge',
                            'unsupported-type': 'page.background.errorWebType',
                            storage: 'page.background.errorStorage',
                        }[saved.reason];
                        setError(
                            t(key, {
                                mb: Math.round(appConfig.background.maxWebBytes / 1024 / 1024),
                            }),
                        );
                        return;
                    }
                    setBackgroundWeb(saved.web);
                    setBackgroundKind('web');
                    setBackgroundEnabled(true);
                    setNotice(t('page.background.assistantImported'));
                })();
            },
        });
    };

    const download = () => {
        if (!result) return;
        const url = URL.createObjectURL(new Blob([result.html], {type: 'text/html'}));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = outputName();
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    return (
        <section className={styles.card}>
            <div className={styles.cacheHeader}>
                <h2 className={styles.cardTitle}>{t('page.background.assistantTitle')}</h2>
                <Button size="sm" variant="ghost" onClick={pickDirectory}>
                    {t('page.background.assistantSelect')}
                </Button>
            </div>
            <p className={styles.hint}>{t('page.background.assistantHint')}</p>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.background.assistantSource')}</span>
                <span className={styles.path}>
                    {files.length > 0
                        ? t('page.background.assistantSelected', {
                              files: files.length,
                              size: formatBytes(totalBytes),
                          })
                        : t('page.background.assistantNoFiles')}
                </span>
            </div>

            {entries.length > 0 && (
                <div className={styles.field}>
                    <span className={styles.label}>{t('page.background.assistantEntry')}</span>
                    {entries.length > 1 ? (
                        <select
                            className={styles.input}
                            value={entryPath}
                            onChange={(event) => {
                                setEntryPath(event.target.value);
                                setResult(null);
                            }}
                        >
                            {entries.map((path) => (
                                <option key={path} value={path}>
                                    {path}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <span className={styles.path}>{entryPath}</span>
                    )}
                </div>
            )}

            <div className={styles.cacheActions}>
                <Button size="sm" disabled={files.length === 0 || busy} onClick={() => void build()}>
                    {busy ? t('page.background.assistantBuilding') : t('page.background.assistantBuild')}
                </Button>
                {result && (
                    <>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={apply}>
                            {t('page.background.assistantApply')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={download}>
                            {t('page.background.assistantDownload')}
                        </Button>
                    </>
                )}
            </div>

            {result && (
                <>
                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.background.assistantOutput')}</span>
                        <span className={styles.valueText}>
                            {t('page.background.assistantOutputMeta', {
                                size: formatBytes(result.bytes),
                                files: result.files,
                                inlined: result.inlined,
                            })}
                        </span>
                    </div>
                    <p className={styles.hint}>
                        {result.removedScripts > 0 &&
                            `${t('page.background.assistantScriptsRemoved', {
                                count: result.removedScripts,
                            })} `}
                        {result.removedExternal > 0 &&
                            t('page.background.assistantExternalRemoved', {
                                count: result.removedExternal,
                            })}
                    </p>
                    {result.warnings.length > 0 && (
                        <>
                            <span className={styles.label}>
                                {t('page.background.assistantWarnings')}
                            </span>
                            <ul className={styles.assistantList}>
                                {result.warnings.map((warning) => (
                                    <li key={warning}>
                                        {t(`page.background.assistantWarn.${warning}`)}
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </>
            )}

            {error && <p className={styles.error}>{error}</p>}
            {notice && <p className={styles.notice}>{notice}</p>}

            <div className={styles.blockDivider}/>

            <h3 className={styles.subTitle}>{t('page.background.assistantVideoTitle')}</h3>
            <p className={styles.hint}>{t('page.background.assistantVideoHint')}</p>

            <h3 className={styles.subTitle}>{t('page.background.assistantSceneTitle')}</h3>
            <p className={styles.hint}>{t('page.background.assistantSceneHint')}</p>

            <h3 className={styles.subTitle}>{t('page.background.assistantPresetTitle')}</h3>
            <p className={styles.hint}>{t('page.background.assistantPresetHint')}</p>

            <input
                ref={dirRef}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                    handleFiles(event.currentTarget.files);
                    event.currentTarget.value = '';
                }}
            />
        </section>
    );
}

export default WallpaperAssistant;
