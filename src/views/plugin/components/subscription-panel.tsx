import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {CatalogEntry, CoreResult, PluginImportPreview, Subscription} from '../../../api';
import {Button} from '../../../components/ui/button';
import {BadgeCell, TextCell} from '../../../components/ui/data-table';
import {useConfirm} from '../../../hooks/useConfirm';
import {errorText} from '../../../i18n/errors';
import {coreAvailable, corePlugin} from '../../../services';
import {
    corePluginAddSubscription,
    corePluginCatalog,
    corePluginRefreshSubscription,
    corePluginRemoveSubscription,
    corePluginSubscriptions,
} from '../../../services/core.plugin';
import {formatDateTime} from '../../../utils/date';
import {PERMISSION_LABEL} from '../permissions';
import styles from '../plugin.module.css';

/**
 * 订阅源面板（社区仓库索引，契约 §2 `plugin.subscriptions.*` / `plugin.catalog.list`）。
 *
 * **中立立场（ADR-0005）**：这里不预置任何订阅地址、不出现「官方/推荐」措辞；
 * URL 必须由用户自己粘贴——应用只是一个读取 `repository.json` 的客户端。
 *
 * **安装仍是「预览 → 显式同意 → 安装」**：订阅里的一键安装省的是「找文件」这一步，
 * 不是省掉同意——权限与凭据照样先摆出来（社区插件是不可信代码，AGENTS 约束 14）。
 */
export function SubscriptionPanel() {
    const {t} = useTranslation();
    const confirm = useConfirm();
    const available = coreAvailable();

    const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
    const [entries, setEntries] = useState<CatalogEntry[]>([]);
    const [url, setUrl] = useState('');
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    /** 订阅内一键安装：先把预览摆出来，拿到勾选再落盘 */
    const [pending, setPending] = useState<{
        entry: CatalogEntry;
        preview: PluginImportPreview;
        consent: boolean;
    } | null>(null);

    const refresh = useCallback(async () => {
        setError(null);
        const [list, catalog] = await Promise.all([corePluginSubscriptions(), corePluginCatalog()]);
        setSubscriptions(list ?? []);
        setEntries(catalog ?? []);
    }, []);

    useEffect(() => {
        if (available) void refresh();
    }, [available, refresh]);

    /** 统一动作包装：失败只提示，不抛 */
    const run = async (action: () => Promise<CoreResult<unknown>>, done: string) => {
        setBusy(true);
        setError(null);
        const result = await action();
        setBusy(false);
        if (!result.ok) {
            // 刷新失败不算「订阅没了」：核心保留旧索引并报 subscription.fetch_failed
            setError(errorText(t, result.error));
            return;
        }
        setStatus(done);
        await refresh();
    };

    const add = async () => {
        if (!url.trim()) {
            setError(t('page.plugin.subscriptionNeedUrl'));
            return;
        }
        await run(() => corePluginAddSubscription(url.trim(), name.trim()), t('page.plugin.subscriptionAdded'));
        setUrl('');
        setName('');
    };

    const previewEntry = async (entry: CatalogEntry) => {
        setBusy(true);
        setError(null);
        const result = await corePlugin.preview({
            kind: 'catalog',
            subscriptionId: entry.subscriptionId,
            fileName: entry.fileName,
        });
        setBusy(false);
        if (!result.ok) {
            setError(errorText(t, result.error));
            return;
        }
        setPending({entry, preview: result.data, consent: false});
    };

    const installEntry = async () => {
        if (!pending) return;
        const from = {
            kind: 'catalog' as const,
            subscriptionId: pending.entry.subscriptionId,
            fileName: pending.entry.fileName,
        };
        setBusy(true);
        setError(null);
        const result = await corePlugin.install(from, pending.preview.compat);
        if (!result.ok) {
            setBusy(false);
            setError(errorText(t, result.error));
            return;
        }
        // 安装只落盘；建运行时并探测能力，插件才真正可用
        const reloaded = await corePlugin.reload(result.data.plugin.id);
        setBusy(false);
        if (!reloaded.ok) setError(errorText(t, reloaded.error));
        setPending(null);
        setStatus(t('page.plugin.subscriptionInstalled', {name: result.data.plugin.name}));
        await refresh();
    };

    if (!available) {
        return (
            <section className={styles.card}>
                <h2 className={styles.cardTitle}>{t('page.plugin.subscriptionTitle')}</h2>
                <p className={styles.hint}>{t('page.plugin.browserNotice')}</p>
            </section>
        );
    }

    return (
        <section className={styles.card}>
            <h2 className={styles.cardTitle}>{t('page.plugin.subscriptionTitle')}</h2>
            <p className={styles.hint}>{t('page.plugin.subscriptionHint')}</p>

            {/* 添加订阅：URL 由用户提供（指向一个 repository.json） */}
            <div className={styles.field}>
                <span className={styles.label}>{t('page.plugin.subscriptionUrlLabel')}</span>
                <input
                    className={styles.input}
                    type="url"
                    value={url}
                    placeholder={t('page.plugin.subscriptionUrlPlaceholder')}
                    onChange={(event) => setUrl(event.target.value)}
                />
            </div>
            <div className={styles.field}>
                <span className={styles.label}>{t('page.plugin.subscriptionNameLabel')}</span>
                <input
                    className={styles.input}
                    type="text"
                    value={name}
                    placeholder={t('page.plugin.subscriptionNamePlaceholder')}
                    onChange={(event) => setName(event.target.value)}
                />
            </div>
            <div className={styles.actions}>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void add()}>
                    {t('page.plugin.subscriptionAdd')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
                    {t('page.plugin.subscriptionReload')}
                </Button>
            </div>

            {subscriptions.length === 0 ? (
                <p className={styles.hint}>{t('page.plugin.subscriptionEmpty')}</p>
            ) : (
                <ul className={styles.list}>
                    {subscriptions.map((subscription) => (
                        <li key={subscription.id} className={styles.row}>
                            <span>
                                <TextCell>{subscription.name}</TextCell>{' '}
                                <TextCell tone="muted">{t('page.plugin.subscriptionCount', {count: subscription.count})}</TextCell>{' '}
                                {subscription.updatedAt ? (
                                    <TextCell tone="muted">
                                        {t('page.plugin.subscriptionUpdated', {
                                            time: formatDateTime(subscription.updatedAt),
                                        })}
                                    </TextCell>
                                ) : (
                                    <TextCell tone="muted">{t('page.plugin.subscriptionNeverRefreshed')}</TextCell>
                                )}
                                {/* 刷新失败：索引还在（旧的那份），但要让用户看见原因 */}
                                {subscription.error && <BadgeCell tone="warning">{subscription.error}</BadgeCell>}
                            </span>
                            <span className={styles.actions}>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() =>
                                        void run(
                                            () => corePluginRefreshSubscription(subscription.id),
                                            t('page.plugin.subscriptionRefreshed'),
                                        )
                                    }
                                >
                                    {t('page.plugin.subscriptionRefresh')}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() =>
                                        confirm({
                                            titleKey: 'confirm.removeSubscriptionTitle',
                                            descKey: 'confirm.removeSubscriptionDesc',
                                            descParams: {name: subscription.name},
                                            tone: 'danger',
                                            onConfirm: () =>
                                                void run(
                                                    () => corePluginRemoveSubscription(subscription.id),
                                                    t('page.plugin.subscriptionRemoved'),
                                                ),
                                        })
                                    }
                                >
                                    {t('common.delete')}
                                </Button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            {/* 订阅内的可安装条目 */}
            <span className={styles.label}>{t('page.plugin.catalogTitle')}</span>
            {entries.length === 0 ? (
                <p className={styles.hint}>{t('page.plugin.catalogEmpty')}</p>
            ) : (
                <ul className={styles.list}>
                    {entries.map((entry) => (
                        <li key={`${entry.subscriptionId}:${entry.fileName}`} className={styles.row}>
                            <span>
                                <TextCell>{entry.name}</TextCell>{' '}
                                <TextCell tone="muted">v{entry.version}</TextCell>{' '}
                                {entry.author && <TextCell tone="muted">{entry.author}</TextCell>}{' '}
                                <TextCell tone="muted">{entry.subscriptionName}</TextCell>{' '}
                                {entry.installed && (
                                    <BadgeCell tone="success">{t('page.plugin.catalogInstalled')}</BadgeCell>
                                )}
                                {entry.updateAvailable && (
                                    <BadgeCell tone="warning">{t('page.plugin.catalogUpdate')}</BadgeCell>
                                )}
                            </span>
                            <span className={styles.actions}>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={busy}
                                    onClick={() => void previewEntry(entry)}
                                >
                                    {t('page.plugin.catalogInstall')}
                                </Button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            {pending && (
                <div className={styles.preview}>
                    <span className={styles.previewTitle}>
                        {pending.preview.manifest.name} · v{pending.preview.manifest.version}
                        <TextCell tone="muted"> {pending.preview.manifest.author}</TextCell>
                    </span>
                    <TextCell tone="muted">{pending.preview.manifest.description}</TextCell>

                    {pending.preview.compat && (
                        <TextCell tone="warning">{t('page.plugin.compatWarning')}</TextCell>
                    )}

                    <span className={styles.label}>{t('page.plugin.permissions')}</span>
                    <ul className={styles.list}>
                        {pending.preview.permissions.length === 0 ? (
                            <li>{t('page.plugin.permissionNone')}</li>
                        ) : (
                            pending.preview.permissions.map((permission) => (
                                <li key={permission}>
                                    ·{' '}
                                    {t(
                                        permission === 'network' && pending.preview.compat
                                            ? 'page.plugin.permissionNetworkCompat'
                                            : PERMISSION_LABEL[permission],
                                    )}
                                </li>
                            ))
                        )}
                    </ul>

                    {pending.preview.credentials.length > 0 && (
                        <>
                            <span className={styles.label}>{t('page.plugin.credentials')}</span>
                            <ul className={styles.list}>
                                {pending.preview.credentials.map((credential) => (
                                    <li key={credential.key}>
                                        · {credential.label}
                                        {credential.required ? `（${t('page.plugin.required')}）` : ''}
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}

                    {pending.preview.warnings.length > 0 && (
                        <ul className={styles.list}>
                            {pending.preview.warnings.map((warning) => (
                                <li key={warning}>· {warning}</li>
                            ))}
                        </ul>
                    )}

                    <label className={styles.consent}>
                        <input
                            className={styles.checkbox}
                            type="checkbox"
                            checked={pending.consent}
                            onChange={(event) =>
                                setPending((prev) => (prev ? {...prev, consent: event.target.checked} : prev))
                            }
                        />
                        <span>{t('page.plugin.consent')}</span>
                    </label>

                    <div className={styles.actions}>
                        <Button
                            size="sm"
                            variant="primary"
                            disabled={!pending.consent || busy}
                            onClick={() => void installEntry()}
                        >
                            {busy ? t('page.plugin.installing') : t('page.plugin.install')}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
                            {t('common.cancel')}
                        </Button>
                    </div>
                </div>
            )}

            {status && <TextCell tone="accent">{status}</TextCell>}
            {error && <TextCell tone="danger">{error}</TextCell>}
            <p className={styles.hint}>{t('page.plugin.disclaimer')}</p>
        </section>
    );
}

export default SubscriptionPanel;
