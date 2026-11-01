import {useCallback, useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {OAuthStatus} from '../../../api';
import type {PluginInfo} from '../../../types';
import {Button} from '../../../components/ui/button';
import {BadgeCell, TextCell} from '../../../components/ui/data-table';
import {useConfirm} from '../../../hooks/useConfirm';
import {errorText} from '../../../i18n/errors';
import {isTauri} from '../../../services';
import {oauthBegin, oauthCancel, oauthListen, oauthSignOut, oauthStatus} from '../../../services/core.oauth';
import styles from '../plugin.module.css';

/**
 * 插件的**第三方授权**卡片（契约 `auth.*`）。
 *
 * 只有清单里声明了 `@oauth` 的插件才显示——没有声明就说明它不用第三方登录，
 * 界面不该凭空出现一个「授权」按钮。
 *
 * 五个必须说清楚的边界（都来自契约）：
 * 1. 授权页在**系统浏览器**里打开：用户能在地址栏看到真实域名，应用不嵌 WebView；
 * 2. 令牌**不回前端**：这里只有「已授权 / 过期时间 / scope」，插件在沙箱里自己取；
 * 3. 端点由**插件**声明，应用不内置任何第三方地址；
 * 4. 落点是系统凭据库；降级为进程内存储时界面如实说「重启后失效」；
 * 5. 等待回调有 180s 上限，可以取消；取消后按钮回到「授权」。
 */
export function PluginAuth({plugin}: {plugin: PluginInfo}) {
    const {t} = useTranslation();
    const confirm = useConfirm();

    /* 清单可能还没读到（浏览器预览的演示源没有 manifest）：没有声明就是不显示 */
    const declared = plugin.manifest?.oauth;
    const [status, setStatus] = useState<OAuthStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** 等待回调的兜底计时器：核心 180s 后才放弃，界面不能一直转 */
    const timer = useRef<number | null>(null);

    const load = useCallback(async () => {
        const next = await oauthStatus(plugin.id);
        setStatus(next);
        setWaiting(next?.pending ?? false);
    }, [plugin.id]);

    useEffect(() => {
        void load();
    }, [load]);

    // 回调线程换到令牌后立刻推送：不用轮询，也不会出现「等半天界面不动」
    useEffect(() => {
        let dispose: (() => void) | null = null;
        let cancelled = false;
        void oauthListen((payload) => {
            if (payload.pluginId !== plugin.id) return;
            setWaiting(false);
            if (!payload.authorized) setError(t('page.plugin.authFailed'));
            void load();
        }).then((unlisten) => {
            if (cancelled) unlisten();
            else dispose = unlisten;
        });
        return () => {
            cancelled = true;
            dispose?.();
        };
    }, [plugin.id, load, t]);

    useEffect(() => () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
    }, []);

    if (!declared) return null;

    const authorize = async () => {
        setBusy(true);
        setError(null);
        const result = await oauthBegin(plugin.id);
        setBusy(false);
        if (!result.ok) {
            setError(errorText(t, result.error));
            setWaiting(false);
            return;
        }
        setWaiting(true);
        // 兜底：核心到点会自己放弃，界面这边同步收尾，避免一直显示「等待授权」
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
            setWaiting(false);
            void load();
        }, 190_000);
    };

    const cancel = async () => {
        const result = await oauthCancel(plugin.id);
        if (!result.ok) {
            setError(errorText(t, result.error));
            return;
        }
        setWaiting(false);
        await load();
    };

    const signOut = () => {
        confirm({
            titleKey: 'page.plugin.authSignOutConfirmTitle',
            descKey: 'page.plugin.authSignOutConfirmDesc',
            tone: 'danger',
            onConfirm: async () => {
                const result = await oauthSignOut(plugin.id);
                if (!result.ok) setError(errorText(t, result.error));
                await load();
            },
        });
    };

    const authorized = status?.authorized ?? false;
    const expires = status?.expiresAt
        ? new Date(status.expiresAt).toLocaleString()
        : null;
    const persistent = status ? status.backend !== 'memory' : null;

    return (
        <div className={styles.oauth}>
            <span className={styles.label}>{t('page.plugin.authTitle')}</span>

            <div className={styles.row}>
                <span className={styles.credentialLabel}>
                    <BadgeCell tone={authorized ? 'success' : 'muted'}>
                        {authorized ? t('page.plugin.authAuthorized') : t('page.plugin.authUnauthorized')}
                    </BadgeCell>
                    {declared.scopes.length > 0 && (
                        <TextCell tone="muted">
                            {t('page.plugin.authScopes', {scopes: declared.scopes.join(' ')})}
                        </TextCell>
                    )}
                    {authorized && expires && (
                        <TextCell tone="muted">{t('page.plugin.authExpires', {time: expires})}</TextCell>
                    )}
                </span>

                <span className={styles.actions}>
                    {waiting ? (
                        <>
                            <TextCell tone="muted">{t('page.plugin.authWaiting')}</TextCell>
                            <Button size="sm" variant="ghost" onClick={() => void cancel()}>
                                {t('common.cancel')}
                            </Button>
                        </>
                    ) : (
                        <Button
                            size="sm"
                            variant={authorized ? 'ghost' : 'primary'}
                            disabled={busy || !isTauri()}
                            onClick={() => void authorize()}
                        >
                            {authorized ? t('page.plugin.authReauthorize') : t('page.plugin.authAuthorize')}
                        </Button>
                    )}
                    {authorized && !waiting && (
                        <Button size="sm" variant="ghost" onClick={signOut}>
                            {t('page.plugin.authSignOut')}
                        </Button>
                    )}
                </span>
            </div>

            {/* 三条如实说明：端点来源 / 令牌去处 / 明文风险 */}
            <p className={styles.hint}>{t('page.plugin.authEndpointHint')}</p>
            <p className={styles.hint}>
                {t(persistent === false ? 'page.plugin.authRestartHint' : 'page.plugin.authStoredHint')}
            </p>
            {!declared.pkce && <p className={styles.hint}>{t('page.plugin.authNoPkceHint')}</p>}
            {!isTauri() && <p className={styles.hint}>{t('page.plugin.authDesktopOnly')}</p>}
            {error && <TextCell tone="danger">{error}</TextCell>}
        </div>
    );
}

export default PluginAuth;
