import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {errorText} from '../../../i18n/errors';
import type {CoreResult, ImportSource, PluginImportPreview, PluginSummary} from '../../../api';
import {Button} from '../../../components/ui/button';
import {UnderlineRadioGroup} from '../../../components/ui/radio-group';
import {BadgeCell, TextCell} from '../../../components/ui/data-table';
import {useConfirm} from '../../../hooks/useConfirm';
import {coreAvailable, corePlugin, libraryService} from '../../../services';
import {PERMISSION_LABEL} from '../permissions';

/** 授权地址里的域名（只用于展示「浏览器会被带去哪个域名」） */
function oauthHost(url: string): string {
    const rest = url.replace(/^https?:\/\//, '');
    return rest.split(/[/?#]/)[0] || url;
}
import {PluginSettings} from './plugin-settings';
import styles from '../plugin.module.css';

type SourceMode = 'paste' | 'url' | 'path';

/** 本机路径来源的三种形态（契约里的 `file` / `dir` / `archive`） */
type PathKind = 'file' | 'dir' | 'archive';

/**
 * 本机核心插件面板：导入（粘贴 / 地址 / 本机路径）→ 权限确认 → 安装。
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
    const confirm = useConfirm();
    const available = coreAvailable();

    const [mode, setMode] = useState<SourceMode>('paste');
    const [text, setText] = useState('');
    const [url, setUrl] = useState('');
    const [pathKind, setPathKind] = useState<PathKind>('archive');
    const [path, setPath] = useState('');
    /** 兼容模式（ADR-0006）：默认关闭，只有用户显式勾选才会请求核心开启 */
    const [compat, setCompat] = useState(false);
    const [preview, setPreview] = useState<PluginImportPreview | null>(null);
    const [consent, setConsent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [installed, setInstalled] = useState<PluginSummary[]>([]);
    /** 正在展开管理面板（凭据 / 配置）的插件 id */
    const [settingsId, setSettingsId] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        const result = await corePlugin.list();
        setInstalled(result.ok ? result.data : []);
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

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

    /** 统一动作包装：失败只提示，不抛；结束后刷新列表 */
    const run = async (action: () => Promise<CoreResult<unknown>>) => {
        setBusy(true);
        setError(null);
        const result = await action();
        if (!result.ok) setError(errorText(t, result.error));
        setBusy(false);
        await refresh();
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
            await refresh();
        } else {
            setError(errorText(t, result.error));
        }
        setBusy(false);
    };

    /**
     * 兼容模式收敛（ADR-0006/TOFU）：先把观测到的域名摆给用户看，确认后固化成白名单。
     *
     * 这是**收窄**动作（之后该插件只能访问这些域名），因此走二次确认；
     * 没有观测记录时明确提示「先使用一次」，而不是弹一个空列表。
     */
    const converge = async (plugin: PluginSummary) => {
        setBusy(true);
        setError(null);
        const result = await corePlugin.observedHosts(plugin.id);
        setBusy(false);
        if (!result.ok) {
            setError(errorText(t, result.error));
            return;
        }
        const hosts = result.data.hosts.map((entry) => entry.host);
        if (hosts.length === 0) {
            setError(t('page.plugin.compatNoHosts'));
            return;
        }
        confirm({
            titleKey: 'confirm.compatTitle',
            descKey: 'confirm.compatDesc',
            descParams: {name: plugin.name, hosts: hosts.join(' / ')},
            tone: 'danger',
            onConfirm: () => run(() => corePlugin.confirmHosts(plugin.id, hosts)),
        });
    };

    /** 上/下移：整表重排后按 10 递增回写优先级（默认优先级都相同，交换数值无效，必须重排） */
    const move = async (index: number, delta: number) => {
        const target = index + delta;
        if (target < 0 || target >= installed.length) return;
        const next = [...installed];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);

        setBusy(true);
        setError(null);
        for (const [position, plugin] of next.entries()) {
            const want = (position + 1) * 10;
            if (plugin.priority === want) continue;
            /* 走 `libraryService`（而不是直接 `corePlugin`）：内置演示源不在核心里，
               服务层会跳过它——直接发过去只会换回一条 `common.not_found` 并弹错 */
            const result = await libraryService.setPluginPriority(plugin.id, want);
            if (!result.ok) {
                setError(errorText(t, result.error));
                break;
            }
        }
        setBusy(false);
        await refresh();
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
                            {/* 形态必须由用户选：单文件 / 目录包 / 压缩包在核心里是三条不同的解析路径 */}
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
                                        setPath(event.target.value);
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

                    <span className={styles.label}>{t('page.plugin.installed')}</span>
                    {installed.length === 0 ? (
                        <p className={styles.hint}>{t('page.plugin.installedEmpty')}</p>
                    ) : (
                        <ul className={styles.list}>
                            {installed.map((plugin, index) => (
                                <li key={plugin.id} className={styles.row}>
                                    <span>
                                        <TextCell>{plugin.name}</TextCell>{' '}
                                        <TextCell tone="muted">v{plugin.version}</TextCell>{' '}
                                        <BadgeCell tone={plugin.enabled ? 'success' : 'muted'}>
                                            {plugin.enabled ? t('common.enabled') : t('common.disabled')}
                                        </BadgeCell>
                                        {/* 兼容插件不能与自有 ABI 插件看起来同等安全 */}
                                        {plugin.compat && (
                                            <BadgeCell tone="warning">{t('page.plugin.compatBadge')}</BadgeCell>
                                        )}
                                    </span>
                                    <span className={styles.actions}>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() => void move(index, -1)}
                                        >
                                            {t('page.plugin.moveUp')}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() => void move(index, 1)}
                                        >
                                            {t('page.plugin.moveDown')}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() =>
                                                void run(() => corePlugin.setEnabled(plugin.id, !plugin.enabled))
                                            }
                                        >
                                            {plugin.enabled ? t('common.disable') : t('common.enable')}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() => void run(() => corePlugin.reload(plugin.id))}
                                        >
                                            {t('page.plugin.reload')}
                                        </Button>
                                        {/* 凭据 / 配置：作者声明了凭据却没有填写入口，插件就永远是摆设 */}
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() =>
                                                setSettingsId(settingsId === plugin.id ? null : plugin.id)
                                            }
                                        >
                                            {settingsId === plugin.id
                                                ? t('page.plugin.settingsClose')
                                                : t('page.plugin.settings')}
                                        </Button>
                                        {/* 兼容插件：把观测到的域名固化成白名单（TOFU 收敛，二次确认） */}
                                        {plugin.compat && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                disabled={busy}
                                                onClick={() => void converge(plugin)}
                                            >
                                                {t('page.plugin.compatConverge')}
                                            </Button>
                                        )}
                                        {/* 卸载是不可逆的落盘操作：必须走二次确认（AGENTS 约束 11） */}
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() =>
                                                confirm({
                                                    titleKey: 'confirm.uninstallPluginTitle',
                                                    descKey: 'confirm.uninstallPluginDesc',
                                                    descParams: {name: plugin.name},
                                                    tone: 'danger',
                                                    onConfirm: () => run(() => corePlugin.remove(plugin.id)),
                                                })
                                            }
                                        >
                                            {t('common.uninstall')}
                                        </Button>
                                    </span>

                                    {/* 管理面板挂在插件行下面（同一行渲染，不引入路由） */}
                                    {settingsId === plugin.id && <PluginSettings plugin={plugin}/>}
                                </li>
                            ))}
                        </ul>
                    )}

                    <p className={styles.hint}>{t('page.plugin.disclaimer')}</p>
                </>
            )}
        </section>
    );
}
