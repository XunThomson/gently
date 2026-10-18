import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {CoreError, WebLoginPlan} from '../../../api';
import {Button} from '../../../components/ui/button';
import {errorText} from '../../../i18n/errors';
import {catalogService} from '../../../services';
import styles from './plugin-qr-login.module.css';

interface Props {
    pluginId: string;
    /** 登录确认后回调（刷新凭据状态、重新取数据） */
    onConfirmed: () => void;
}

/**
 * 「浏览器窗口登录」：打开**源站自己的登录页**，登录完成后由宿主自动读取 webview 的会话。
 *
 * 与二维码登录的分工：
 * - 二维码登录：插件仿写站点接口，会话从接口响应里来（受站点风控影响大）；
 * - 这里：用户面对的是站点自己的页面（扫码、密码都在页面里完成），会话从 **webview 的 Cookie 罐**
 *   里来——等价于「在浏览器里登录后复制 Cookie」，但全自动。
 *
 * 界面只拿得到状态：登录页地址来自插件清单（`@login`），会话值不经过前端。
 */
export function PluginWebLogin({pluginId, onConfirmed}: Props) {
    const {t} = useTranslation();
    const [plan, setPlan] = useState<WebLoginPlan | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const [canceled, setCanceled] = useState(false);
    const [error, setError] = useState<CoreError | string | null>(null);

    useEffect(() => {
        let cancelled = false;
        void catalogService.loginWebPlan(pluginId).then((outcome) => {
            if (cancelled) return;
            setPlan(outcome.data);
            if (outcome.error) setError(outcome.error);
        });
        return () => {
            cancelled = true;
        };
    }, [pluginId]);

    const start = async () => {
        setBusy(true);
        setError(null);
        setDone(false);
        setCanceled(false);
        try {
            const outcome = await catalogService.loginWeb(pluginId);
            if (outcome.error) {
                setError(outcome.error);
                return;
            }
            if (outcome.data?.state === 'confirmed') {
                setDone(true);
                onConfirmed();
            } else {
                setCanceled(true);
            }
        } finally {
            setBusy(false);
        }
    };

    /** 只显示域名：完整 URL 可能有查询串，摆出来既没用又长 */
    const hostOf = (url: string): string => {
        try {
            return new URL(url).host;
        } catch {
            return url;
        }
    };

    const status = done
        ? t('page.plugin.webLoginDone')
        : canceled
          ? t('page.plugin.webLoginCanceled')
          : busy
            ? t('page.plugin.webLoginWaiting')
            : '';

    return (
        <div className={styles.wrap}>
            <span className={styles.title}>{t('page.plugin.webLoginTitle')}</span>
            <p className={styles.hint}>{t('page.plugin.webLoginHint')}</p>
            {plan && (
                <p className={styles.hint}>
                    {t('page.plugin.webLoginHost', {host: hostOf(plan.url)})}
                </p>
            )}

            <div className={styles.actions}>
                <Button size="sm" disabled={busy || !plan} onClick={() => void start()}>
                    {t('page.plugin.webLoginStart')}
                </Button>
                {status && <span className={styles.status}>{status}</span>}
            </div>

            {error && (
                <p className={styles.error}>{typeof error === 'string' ? error : errorText(t, error)}</p>
            )}
        </div>
    );
}
