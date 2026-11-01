import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {errorText} from '../../../i18n/errors';
import type {ImportSource, PluginImportPreview} from '../../../api';
import {Button} from '../../../components/ui/button';
import {UnderlineRadioGroup} from '../../../components/ui/radio-group';
import {TextCell} from '../../../components/ui/data-table';
import {coreAvailable, corePlugin} from '../../../services';
import {useActions} from '../../../store';
import {PERMISSION_LABEL} from '../permissions';

/** 授权地址里的域名（只用于展示「浏览器会被带去哪个域名」） */
function oauthHost(url: string): string {
    const rest = url.replace(/^https?:\/\//, '');
    return rest.split(/[/?#]/)[0] || url;
}

import styles from '../plugin.module.css';

type SourceMode = 'paste' | 'url' | 'path';

/** 本机路径来源的三种形态（契约里的 `file` / `dir` / `archive`） */
type PathKind = 'file' | 'dir' | 'archive';

/**
 * 按扩展名猜形态（纯函数，冒烟里断言）。
 *
 * `.zip` 一定是压缩包；`.js` / `.json` 等其余文本按单文件；目录认不出来（没有扩展名时保持单文件，
 * 用户自己切「目录包」）。猜错的代价只是再点一次单选框，比「默认压缩包 + 单文件路径」
 * 直接报「格式不合法」友好得多。
 */
export function kindFromPath(value: string): PathKind {
    return /\.zip$/i.test(value.trim()) ? 'archive' : 'file';
}

/**
 * 导入表单：粘贴 / 地址 / 本机路径 → 预览权限 → 显式同意 → 安装。
 *
 * **只负责「导入」这一件事**：已安装插件的列表、启停、优先级、重载、凭据配置都在插件页的
 * 表格与管理面板里（`views/plugin/index.tsx` + `plugin-manage.tsx`）。以前这里还自带一份
 * 「已导入的插件」清单，同一批数据在页面上出现两次（一份在导入面板、一份在下方表格），
 * 既冗余又会出现「导入面板刷新了、表格还是旧的」这种不一致。
 *
 * 三条硬约束体现在这里：
 * 1. **中立立场**（ADR-0005）：界面不预置任何来源、不出现「官方/推荐」措辞，
 *    并常驻第三方免责声明；来源必须由用户自己填写。
 * 2. **同意是硬门槛**：先 `preview`（只读）把权限与凭据需求摆出来，用户显式勾选后才 `install`。
 * 3. **本机路径要用户自己给**：原生文件选择器需要 `tauri-plugin-dialog`（不在离线依赖里），
 *    因此这里不做「浏览…」按钮，而是让用户粘贴/输入路径——不在界面里假装有这个能力。
 *
 * 浏览器（无 Tauri）下不请求任何东西，只说明需要在桌面端操作。
 */
export function ImportPanel() {
    const {t} = useTranslation();
    const available = coreAvailable();
    /* 安装完成后**必须**重读全局插件清单（`plugin.reload()`，不是 `load()`）：
       `load()` 有 loaded 守卫，只在启动时读一次；不强制刷新的话，刚装好的插件
       要等下一次启动才出现在表格 / 音源筛选 / 播放条里（R87 修的 bug）。 */
    const {reload} = useActions().plugin;

    const [mode, setMode] = useState<SourceMode>('paste');
    const [text, setText] = useState('');
    const [url, setUrl] = useState('');
    const [pathKind, setPathKind] = useState<PathKind>('file');
    const [path, setPath] = useState('');
    /** 兼容模式（ADR-0006）：默认关闭，只有用户显式勾选才会请求核心开启 */
    const [compat, setCompat] = useState(false);
    const [preview, setPreview] = useState<PluginImportPreview | null>(null);
    const [consent, setConsent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** 最近一次安装成功的结果（面板常驻在抽屉里，需要一个可见的完成态） */
    const [installedName, setInstalledName] = useState<string | null>(null);

    /** 当前输入对应的导入来源；未填写返回 null */
    const currentSource = (): ImportSource | null => {
        if (mode === 'paste') {
            return text.trim() ? {kind: 'paste', content: text} : null;
        }
        if (mode === 'path') {
            const value = path.trim();
            if (!value) return null;
            // 三种本地形态各有语义：单文件 / 目录包 / 压缩包（核心分别解析）
            return pathKind === 'file'
                ? {kind: 'file', path: value}
                : pathKind === 'dir'
                  ? {kind: 'dir', path: value}
                  : {kind: 'archive', path: value};
        }
        return url.trim() ? {kind: 'url', url: url.trim()} : null;
    };

    const check = async () => {
        const from = currentSource();
        if (!from) {
            setError(t('page.plugin.needSource'));
            return;
        }
        setBusy(true);
        setError(null);
        setInstalledName(null);
        const result = await corePlugin.preview(from, compat);
        if (result.ok) {
            setPreview(result.data);
            setConsent(false);
        } else {
            setPreview(null);
            setError(errorText(t, result.error));
        }
        setBusy(false);
    };

    const install = async () => {
        const from = currentSource();
        if (!from || !consent) return;
        setBusy(true);
        setError(null);
        const result = await corePlugin.install(from, compat);
        if (result.ok) {
            // 安装只落盘；这里顺手建立运行时并探测能力，让插件立刻可用
            const reloaded = await corePlugin.reload(result.data.plugin.id);
            if (!reloaded.ok) setError(errorText(t, reloaded.error));
            setPreview(null);
            setConsent(false);
            setText('');
            setUrl('');
            setInstalledName(result.data.plugin.name);
            // 全局清单 + 按源路由缓存一起刷新：装完就能搜、能播，不需要重启
            await reload();
        } else {
            setError(errorText(t, result.error));
        }
        setBusy(false);
    };

    return (
        <section className={styles.card}>
            <h2 className={styles.cardTitle}>{t('page.plugin.coreTitle')}</h2>

            {!available ? (
                <>
                    <p className={styles.hint}>{t('page.plugin.browserNotice')}</p>
                    <p className={styles.hint}>{t('page.plugin.disclaimer')}</p>
                </>
            ) : (
                <>
                    <p className={styles.hint}>{t('page.plugin.coreHint')}</p>

                    <UnderlineRadioGroup
                        name="plugin-source"
                        value={mode}
                        onChange={(value) => setMode(value as SourceMode)}
                        options={[
                            {value: 'paste', label: t('page.plugin.sourcePaste')},
                            {value: 'url', label: t('page.plugin.sourceUrl')},
                            {value: 'path', label: t('page.plugin.sourcePath')},
                        ]}
                    />

                    {mode === 'paste' && (
                        <div className={styles.field}>
                            <span className={styles.label}>{t('page.plugin.pasteLabel')}</span>
                            <textarea
                                className={styles.textarea}
                                value={text}
                                placeholder={t('page.plugin.pastePlaceholder')}
                                onChange={(event) => {
                                    setText(event.target.value);
                                    setPreview(null);
                                }}
                            />
                        </div>
                    )}

                    {mode === 'url' && (
                        <div className={styles.field}>
                            <span className={styles.label}>{t('page.plugin.urlLabel')}</span>
                            <input
                                className={styles.input}
                                type="url"
                                value={url}
                                placeholder={t('page.plugin.urlPlaceholder')}
                                onChange={(event) => {
                                    setUrl(event.target.value);
                                    setPreview(null);
                                }}
                            />
                        </div>
                    )}

                    {mode === 'path' && (
                        <>
                            {/* 形态必须由用户确认：单文件 / 目录包 / 压缩包在核心里是三条不同的解析路径。
                                默认值按扩展名猜（`.zip` → 压缩包，其余 → 单文件），用户仍可手动改——
                                R68 实测：默认是「压缩包」，导入单文件 `.js` 时直接报「插件文件格式不合法」
                                （核心那边是「不是可读的 zip」），与界面给的路径提示也对不上。 */}
                            <UnderlineRadioGroup
                                name="plugin-path-kind"
                                value={pathKind}
                                onChange={(value) => {
                                    setPathKind(value as PathKind);
                                    setPreview(null);
                                }}
                                options={[
                                    {value: 'archive', label: t('page.plugin.kindArchive')},
                                    {value: 'file', label: t('page.plugin.kindFile')},
                                    {value: 'dir', label: t('page.plugin.kindDir')},
                                ]}
                            />
                            <div className={styles.field}>
                                <span className={styles.label}>{t('page.plugin.pathLabel')}</span>
                                <input
                                    className={styles.input}
                                    type="text"
                                    value={path}
                                    placeholder={t('page.plugin.pathPlaceholder')}
                                    onChange={(event) => {
                                        const value = event.target.value;
                                        setPath(value);
                                        setPathKind(kindFromPath(value));
                                        setPreview(null);
                                    }}
                                />
                            </div>
                            <p className={styles.hint}>{t('page.plugin.pathHint')}</p>
                        </>
                    )}

                    {/* 兼容模式默认关闭：权限弱于自有 ABI，必须由用户主动选择（ADR-0006） */}
                    <label className={styles.consent}>
                        <input
                            className={styles.checkbox}
                            type="checkbox"
                            checked={compat}
                            onChange={(event) => {
                                setCompat(event.target.checked);
                                setPreview(null);
                                setConsent(false);
                            }}
                        />
                        <span>{t('page.plugin.compatLabel')}</span>
                    </label>
                    <TextCell tone="muted">{t('page.plugin.compatHint')}</TextCell>

                    <div className={styles.actions}>
                        <Button size="sm" variant="ghost" onClick={() => void check()} disabled={busy}>
                            {busy ? t('page.plugin.checking') : t('page.plugin.check')}
                        </Button>
                    </div>

                    {preview && (
                        <div className={styles.preview}>
                            <span className={styles.previewTitle}>
                                {preview.manifest.name} · v{preview.manifest.version}
                                <TextCell tone="muted"> {preview.manifest.author}</TextCell>
                            </span>
                            <TextCell tone="muted">{preview.manifest.description}</TextCell>

                            {/* 兼容模式必须显式提示代价：权限弱于自有 ABI（ADR-0006 第 4 条） */}
                            {preview.compat && (
                                <TextCell tone="warning">{t('page.plugin.compatWarning')}</TextCell>
                            )}

                            <span className={styles.label}>{t('page.plugin.permissions')}</span>
                            <ul className={styles.list}>
                                {preview.permissions.length === 0 ? (
                                    <li>{t('page.plugin.permissionNone')}</li>
                                ) : (
                                    preview.permissions.map((permission) => (
                                        <li key={permission}>
                                            ·{' '}
                                            {t(
                                                permission === 'network' && preview.compat
                                                    ? 'page.plugin.permissionNetworkCompat'
                                                    : PERMISSION_LABEL[permission],
                                            )}
                                        </li>
                                    ))
                                )}
                            </ul>

                            {preview.credentials.length > 0 && (
                                <>
                                    <span className={styles.label}>{t('page.plugin.credentials')}</span>
                                    <ul className={styles.list}>
                                        {preview.credentials.map((credential) => (
                                            <li key={credential.key}>
                                                · {credential.label}
                                                {credential.required ? `（${t('page.plugin.required')}）` : ''}
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            )}

                            {/* 第三方授权必须在同意前说清楚：用户会被告知「这个插件会把你带去哪个域名」 */}
                            {preview.oauth && (
                                <>
                                    <span className={styles.label}>{t('page.plugin.oauthTitle')}</span>
                                    <ul className={styles.list}>
                                        <li>· {t('page.plugin.oauthHost', {host: oauthHost(preview.oauth.authorizeUrl)})}</li>
                                        {preview.oauth.scopes.length > 0 && (
                                            <li>· {t('page.plugin.authScopes', {scopes: preview.oauth.scopes.join(' ')})}</li>
                                        )}
                                        {!preview.oauth.pkce && <li>· {t('page.plugin.authNoPkceHint')}</li>}
                                    </ul>
                                </>
                            )}

                            {preview.warnings.length > 0 && (
                                <>
                                    <span className={styles.label}>{t('page.plugin.warnings')}</span>
                                    <ul className={styles.list}>
                                        {preview.warnings.map((warning) => (
                                            <li key={warning}>· {warning}</li>
                                        ))}
                                    </ul>
                                </>
                            )}

                            {preview.replacesExisting && (
                                <TextCell tone="danger">{t('page.plugin.replaces')}</TextCell>
                            )}

                            <label className={styles.consent}>
                                <input
                                    className={styles.checkbox}
                                    type="checkbox"
                                    checked={consent}
                                    onChange={(event) => setConsent(event.target.checked)}
                                />
                                <span>{t('page.plugin.consent')}</span>
                            </label>

                            <div className={styles.actions}>
                                <Button
                                    size="sm"
                                    variant="primary"
                                    disabled={!consent || busy}
                                    onClick={() => void install()}
                                >
                                    {busy ? t('page.plugin.installing') : t('page.plugin.install')}
                                </Button>
                            </div>
                        </div>
                    )}

                    {error && <TextCell tone="danger">{error}</TextCell>}
                    {installedName && !error && (
                        <TextCell tone="success">
                            {t('page.plugin.installDone', {name: installedName})}
                        </TextCell>
                    )}

                    <p className={styles.hint}>{t('page.plugin.disclaimer')}</p>
                </>
            )}
        </section>
    );
}

export default ImportPanel;
