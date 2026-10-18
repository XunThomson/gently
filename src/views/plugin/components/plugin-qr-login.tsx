import {useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {LoginQrSession, LoginQrStatus} from '../../../api';
import {Button} from '../../../components/ui/button';
import {errorText} from '../../../i18n/errors';
import type {CoreError} from '../../../api';
import {catalogService} from '../../../services';
import {qrSvgDataUrl} from './qr-code';
import styles from './plugin-qr-login.module.css';

/** 轮询间隔：R82 实测网易云的确认窗口只有约 2 秒（802 之后很快变成 8821），
 *  因此这里比常见的 1–2 秒更密——扫完到看见「已登录」基本在同一秒内。 */
const POLL_MS = 300;

interface Props {
    pluginId: string;
    /** 该插件是否已经有凭据（扫码会覆盖它，界面要说清楚） */
    configured?: boolean;
    /** 登录确认后回调（刷新凭据状态、重新取数据） */
    onConfirmed: () => void;
}

/**
 * 插件设置里的**二维码登录**。
 *
 * 分工（契约里写死的）：插件给二维码内容与会话状态，核心轮询并**把会话写进凭据库**，
 * 这个组件只做三件事——画二维码、定时问状态、把状态说清楚。
 * 前端从头到尾**拿不到令牌**：`catalog.loginQrPoll` 只回 `state`。
 */
export function PluginQrLogin({pluginId, configured = false, onConfirmed}: Props) {
    const {t} = useTranslation();
    const [session, setSession] = useState<LoginQrSession | null>(null);
    const [state, setState] = useState<LoginQrStatus['state'] | null>(null);
    const [error, setError] = useState<CoreError | string | null>(null);
    const [busy, setBusy] = useState(false);
    const timer = useRef<number | null>(null);

    const stopPolling = () => {
        if (timer.current !== null) {
            window.clearInterval(timer.current);
            timer.current = null;
        }
    };

    /* 卸载时别把定时器留下（否则离开插件页还在后台打 IPC） */
    useEffect(() => stopPolling, []);

    const poll = (key: string) => {
        stopPolling();
        timer.current = window.setInterval(() => {
            void catalogService.loginQrPoll(pluginId, key).then((outcome) => {
                if (outcome.error) {
                    setError(outcome.error);
                    stopPolling();
                    return;
                }
                const next = outcome.data?.state;
                if (!next) return;
                setState(next);
                if (next === 'confirmed') {
                    stopPolling();
                    setSession(null);
                    onConfirmed();
                } else if (next === 'expired') {
                    stopPolling();
                }
            });
        }, POLL_MS);
    };

    const start = async () => {
        setBusy(true);
        setError(null);
        setState(null);
        try {
            const outcome = await catalogService.loginQr(pluginId);
            if (outcome.error) setError(outcome.error);
            else if (!outcome.data) setError(t('page.plugin.qrNoCore'));
            else {
                setSession(outcome.data);
                setState('waiting');
                if (outcome.data.key) poll(outcome.data.key);
            }
        } finally {
            setBusy(false);
        }
    };

    const statusText =
        state === 'waiting'
            ? t('page.plugin.qrWaiting')
            : state === 'scanned'
              ? t('page.plugin.qrScanned')
              : state === 'expired'
                ? t('page.plugin.qrExpired')
                : state === 'confirmed'
                  ? t('page.plugin.qrConfirmed')
                  : '';

    return (
        <div className={styles.wrap}>
            <span className={styles.title}>{t('page.plugin.qrTitle')}</span>
            <p className={styles.hint}>{t('page.plugin.qrHint')}</p>

            {session?.content ? (
                <div className={styles.qrBox}>
                    <img
                        className={styles.qr}
                        src={qrSvgDataUrl(session.content)}
                        alt={t('page.plugin.qrTitle')}
                        referrerPolicy="no-referrer"
                    />
                    {session.tip && <p className={styles.hint}>{session.tip}</p>}
                    {statusText && <p className={styles.status}>{statusText}</p>}
                    {(state === 'expired' || state === null) && (
                        <Button size="sm" disabled={busy} onClick={() => void start()}>
                            {t('page.plugin.qrRetry')}
                        </Button>
                    )}
                </div>
            ) : (
                <div className={styles.actions}>
                    <Button size="sm" disabled={busy} onClick={() => void start()}>
                        {t('page.plugin.qrStart')}
                    </Button>
                    {statusText && <span className={styles.status}>{statusText}</span>}
                </div>
            )}

            {/* 已经有凭据时明说「再扫会覆盖」：否则用户会以为扫码是必须做的第二步 */}
            {configured && !session && <p className={styles.hint}>{t('page.plugin.qrConfigured')}</p>}

            {error && (
                <p className={styles.error}>
                    {typeof error === 'string' ? error : errorText(t, error)}
                </p>
            )}
        </div>
    );
}
