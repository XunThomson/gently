import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {CoreResult, ImportSource, PluginImportPreview, PluginPermission, PluginSummary} from '../../../api';
import {Button} from '../../../components/ui/button';
import {UnderlineRadioGroup} from '../../../components/ui/radio-group';
import {BadgeCell, TextCell} from '../../../components/ui/data-table';
import {useConfirm} from '../../../hooks/useConfirm';
import {coreAvailable, corePlugin} from '../../../services';
import styles from '../plugin.module.css';

type SourceMode = 'paste' | 'url';

const PERMISSION_LABEL: Record<PluginPermission, string> = {
    network: 'page.plugin.permissionNetwork',
    credentials: 'page.plugin.permissionCredentials',
    'filesystem:read': 'page.plugin.permissionFilesystemRead',
    'filesystem:write': 'page.plugin.permissionFilesystemWrite',
};

/**
 * 本机核心插件面板：导入（粘贴 / 地址）→ 权限确认 → 安装。
 *
 * 两条硬约束体现在这里：
 * 1. **中立立场**（ADR-0005）：界面不预置任何来源、不出现「官方/推荐」措辞，
 *    并常驻第三方免责声明；来源必须由用户自己填写。
 * 2. **同意是硬门槛**：先 `preview`（只读）把权限与凭据需求摆出来，用户显式勾选后才 `install`。
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
    const [preview, setPreview] = useState<PluginImportPreview | null>(null);
    const [consent, setConsent] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [installed, setInstalled] = useState<PluginSummary[]>([]);

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
        const result = await corePlugin.preview(from);
        if (result.ok) {
            setPreview(result.data);
            setConsent(false);
        } else {
            setPreview(null);
            setError(result.error.message);
        }
        setBusy(false);
    };

    /** 统一动作包装：失败只提示，不抛；结束后刷新列表 */
    const run = async (action: () => Promise<CoreResult<unknown>>) => {
        setBusy(true);
        setError(null);
        const result = await action();
        if (!result.ok) setError(result.error.message);
        setBusy(false);
        await refresh();
    };

    const install = async () => {
        const from = currentSource();
        if (!from || !consent) return;
        setBusy(true);
        setError(null);
        const result = await corePlugin.install(from);
        if (result.ok) {
            // 安装只落盘；这里顺手建立运行时并探测能力，让插件立刻可用
            const reloaded = await corePlugin.reload(result.data.plugin.id);
            if (!reloaded.ok) setError(reloaded.error.message);
            setPreview(null);
            setConsent(false);
            setText('');
            setUrl('');
            await refresh();
        } else {
            setError(result.error.message);
        }
        setBusy(false);
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
            const result = await corePlugin.setPriority(plugin.id, want);
            if (!result.ok) {
                setError(result.error.message);
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
                        ]}
                    />

                    {mode === 'paste' ? (
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
                    ) : (
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

                            <span className={styles.label}>{t('page.plugin.permissions')}</span>
                            <ul className={styles.list}>
                                {preview.permissions.length === 0 ? (
                                    <li>{t('page.plugin.permissionNone')}</li>
                                ) : (
                                    preview.permissions.map((permission) => (
                                        <li key={permission}>· {t(PERMISSION_LABEL[permission])}</li>
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
