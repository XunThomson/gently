import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {PluginCredentialStatus, PluginSummary} from '../../../api';
import {Button} from '../../../components/ui/button';
import {BadgeCell, TextCell} from '../../../components/ui/data-table';
import {errorText} from '../../../i18n/errors';
import {probeCore} from '../../../services';
import {
    corePluginConfigGet,
    corePluginConfigPut,
    corePluginCredentialClear,
    corePluginCredentialSet,
    corePluginCredentialStatus,
} from '../../../services/core.plugin';
import styles from '../plugin.module.css';
import {PluginAuth} from './plugin-auth';

/**
 * 单个插件的**管理面板**：凭据 + 配置（契约 `plugin.credentials.*` / `plugin.config.*`）。
 *
 * 为什么要有它：插件作者可以声明「我需要一个账号/一条 cookie」，安装界面会把需求列出来——
 * 但**没有填写入口**的话，那个插件永远是「缺凭据」状态，等于装了个摆设。
 *
 * 两条安全约定（照抄契约，不自行发明）：
 * 1. 凭据只在**清单声明过的键**上读写，界面把 `label`/`secret` 原样展示，值**回显不了**
 *    （`plugin.credentials.status` 只回「是否已配置」，命令层没有读值出口）；
 * 2. 值不经我方任何服务器，落点是本机 `CredentialStore`——**当前是内存实现，重启即失效**，
 *    因此这里必须明说，不能让用户以为填过就一劳永逸。
 */
export function PluginSettings({plugin}: {plugin: PluginSummary}) {
    const {t} = useTranslation();

    const [credentials, setCredentials] = useState<PluginCredentialStatus[] | null>(null);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [config, setConfig] = useState('');
    const [revision, setRevision] = useState(0);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    /** 凭据是否落在系统凭据库里（`null` = 还不知道，先按「不承诺」显示） */
    const [persistent, setPersistent] = useState<boolean | null>(null);

    /* 凭据落点由核心如实上报（`system.status.credentialsBackend`）：
       接上了系统凭据库就明说「重启后仍在」，降级了就明说「重启后要重新填」。 */
    useEffect(() => {
        let cancelled = false;
        void probeCore().then((result) => {
            if (cancelled || !result.ok) return;
            const backend = result.data.credentialsBackend;
            setPersistent(backend !== '' && backend !== 'memory');
        });
        return () => {
            cancelled = true;
        };
    }, []);

    /** 拉取凭据状态与配置（配置以 JSON 文本编辑，未知字段原样保留） */
    const load = useCallback(async () => {
        setError(null);
        const [credentialStatus, configValue] = await Promise.all([
            corePluginCredentialStatus(plugin.id),
            corePluginConfigGet(plugin.id),
        ]);
        setCredentials(credentialStatus ?? []);
        if (configValue) {
            setConfig(Object.keys(configValue.values).length > 0 ? JSON.stringify(configValue.values, null, 2) : '');
            setRevision(configValue.revision);
        }
    }, [plugin.id]);

    useEffect(() => {
        void load();
    }, [load]);

    /** 只提交用户真正填过的键：留空表示「不改动」，清除走单独的按钮 */
    const saveCredentials = async () => {
        const filled = Object.entries(drafts).filter(([, value]) => value.trim().length > 0);
        if (filled.length === 0) {
            setError(t('page.plugin.credentialEmpty'));
            return;
        }

        setBusy(true);
        setError(null);
        for (const [key, value] of filled) {
            const result = await corePluginCredentialSet(plugin.id, key, value);
            if (!result.ok) {
                setError(errorText(t, result.error));
                setBusy(false);
                return;
            }
        }
        // 立刻清空草稿：值不回显，留着只会误导「还能再读出来」
        setDrafts({});
        setStatus(t('page.plugin.credentialSaved', {count: filled.length}));
        setBusy(false);
        await load();
    };

    const clearCredentials = async (key?: string) => {
        setBusy(true);
        setError(null);
        const result = await corePluginCredentialClear(plugin.id, key);
        setBusy(false);
        if (!result.ok) {
            setError(errorText(t, result.error));
            return;
        }
        setStatus(t('page.plugin.credentialCleared'));
        await load();
    };

    const saveConfig = async () => {
        const text = config.trim();
        let values: Record<string, unknown> = {};
        if (text.length > 0) {
            try {
                const parsed: unknown = JSON.parse(text);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    setError(t('page.plugin.configObjectOnly'));
                    return;
                }
                values = parsed as Record<string, unknown>;
            } catch {
                setError(t('page.plugin.configInvalidJson'));
                return;
            }
        }

        setBusy(true);
        setError(null);
        const result = await corePluginConfigPut(plugin.id, values, revision);
        setBusy(false);

        if (!result.ok) {
            // `revision` 不匹配 = 别处改过：提示用户，并给出「重新载入」的动作
            setError(
                result.error.code === 'common.conflict'
                    ? t('page.plugin.configConflict')
                    : errorText(t, result.error),
            );
            return;
        }

        setRevision(result.data.revision);
        setStatus(t('page.plugin.configSaved'));
    };

    return (
        <div className={styles.settings}>
            {/* 第三方授权（只有声明了 @oauth 的插件才出现） */}
            <PluginAuth plugin={plugin} />

            {/* 凭据 */}
            <span className={styles.label}>{t('page.plugin.credentialTitle')}</span>
            {credentials === null ? (
                <p className={styles.hint}>{t('common.loading')}</p>
            ) : credentials.length === 0 ? (
                <p className={styles.hint}>{t('page.plugin.credentialNone')}</p>
            ) : (
                <ul className={styles.list}>
                    {credentials.map((field) => (
                        <li key={field.key} className={styles.credentialRow}>
                            <span className={styles.credentialLabel}>
                                {field.label}{' '}
                                <TextCell tone="muted">{field.key}</TextCell>{' '}
                                <BadgeCell tone={field.present ? 'success' : 'muted'}>
                                    {field.present
                                        ? t('page.plugin.credentialPresent')
                                        : t('page.plugin.credentialMissing')}
                                </BadgeCell>
                            </span>
                            <span className={styles.actions}>
                                <input
                                    className={styles.input}
                                    type={field.secret ? 'password' : 'text'}
                                    value={drafts[field.key] ?? ''}
                                    placeholder={t('page.plugin.credentialPlaceholder')}
                                    onChange={(event) =>
                                        setDrafts((prev) => ({...prev, [field.key]: event.target.value}))
                                    }
                                />
                                {field.present && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={busy}
                                        onClick={() => void clearCredentials(field.key)}
                                    >
                                        {t('page.plugin.credentialClear')}
                                    </Button>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {credentials !== null && credentials.length > 0 && (
                <>
                    <div className={styles.actions}>
                        <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveCredentials()}>
                            {t('page.plugin.save')}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void clearCredentials()}>
                            {t('page.plugin.credentialClearAll')}
                        </Button>
                    </div>
                    {/* 已知缺口必须写出来：系统凭据库不可用时是内存实现 → 重启失效 */}
                    <p className={styles.hint}>
                        {t(persistent === false ? 'page.plugin.credentialRestartHint' : 'page.plugin.credentialStoredHint')}
                    </p>
                </>
            )}

            {/* 配置 */}
            <span className={styles.label}>{t('page.plugin.configTitle')}</span>
            <textarea
                className={styles.textarea}
                value={config}
                placeholder={t('page.plugin.configPlaceholder')}
                onChange={(event) => setConfig(event.target.value)}
            />
            <p className={styles.hint}>{t('page.plugin.configHint', {revision})}</p>
            <div className={styles.actions}>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveConfig()}>
                    {t('page.plugin.save')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
                    {t('page.plugin.configReload')}
                </Button>
            </div>

            {status && <TextCell tone="accent">{status}</TextCell>}
            {error && <TextCell tone="danger">{error}</TextCell>}
        </div>
    );
}

export default PluginSettings;
