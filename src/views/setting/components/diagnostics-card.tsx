import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {SystemPathsDto, SystemStatusDto} from '../../../api';
import {Button} from '../../../components/ui/button';
import {TextCell} from '../../../components/ui/data-table';
import {errorText} from '../../../i18n/errors';
import {coreAvailable, coreSystem, probeCore} from '../../../services';
import styles from '../setting.module.css';

/**
 * 诊断卡片：本机核心的运行状态（契约 `system.status` / `system.paths`）。
 *
 * 数据是**视图内的临时状态**（打开设置就查一次），不进全局 store——
 * 它不被任何其它视图消费，放进 store 只会增加同步面。
 *
 * 浏览器（无 Tauri）下不请求任何东西，直接显示「浏览器模式」，
 * 这样 `pnpm dev` 与冒烟测试都不依赖桌面宿主。
 */
export function DiagnosticsCard() {
    const {t} = useTranslation();
    const available = coreAvailable();
    const [status, setStatus] = useState<SystemStatusDto | null>(null);
    const [paths, setPaths] = useState<SystemPathsDto | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(available);

    const refresh = useCallback(async () => {
        if (!available) return;
        setLoading(true);
        setError(null);

        // 启动时已探测过一次（结果缓存），这里复用避免重复往返；仅 paths 是新请求
        const [statusResult, pathsResult] = await Promise.all([probeCore(), coreSystem.paths()]);
        if (statusResult.ok) setStatus(statusResult.data);
        else setError(errorText(t, statusResult.error));
        if (pathsResult.ok) setPaths(pathsResult.data);
        else setError(errorText(t, pathsResult.error));

        setLoading(false);
    }, [available, t]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const open = useCallback(
        async (path: string) => {
            const result = await coreSystem.reveal(path);
            if (!result.ok) setError(errorText(t, result.error));
        },
        [t],
    );

    /* 凭据是否落在系统凭据库里：`memory` 表示降级（重启后需要重新填写） */
    const persistentCredentials =
        !!status && status.credentialsBackend !== '' && status.credentialsBackend !== 'memory';

    return (
        <section className={styles.card}>
            <h2 className={styles.cardTitle}>{t('page.setting.diagnostics')}</h2>
            <div className={styles.field}>
                <span className={styles.label}>{t('page.setting.diagRuntime')}</span>
                <span className={styles.value}>
                    <TextCell tone={available ? 'accent' : 'muted'}>
                        {available ? t('page.setting.diagAvailable') : t('page.setting.diagUnavailable')}
                    </TextCell>
                    {available && (
                        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
                            {loading ? t('page.setting.diagLoading') : t('page.setting.diagRefresh')}
                        </Button>
                    )}
                </span>
            </div>

            {!available && <p className={styles.hint}>{t('page.setting.diagUnavailableHint')}</p>}

            {available && status && (
                <>
                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.diagVersion')}</span>
                        <span className={styles.value}>
                            <TextCell>v{status.version}</TextCell>
                        </span>
                    </div>

                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.diagPlatform')}</span>
                        <span className={styles.value}>
                            <TextCell tone="muted">{status.platform}</TextCell>
                        </span>
                    </div>

                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.diagDb')}</span>
                        <span className={styles.value}>
                            <TextCell tone={status.dbReady ? 'accent' : 'danger'}>
                                {status.dbReady
                                    ? t('page.setting.diagDbReady')
                                    : t('page.setting.diagDbFailed')}
                            </TextCell>
                        </span>
                    </div>
                    {!status.dbReady && status.dbError && (
                        <p className={styles.hint}>
                            {t('page.setting.diagDbErrorHint', {reason: status.dbError})}
                        </p>
                    )}

                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.diagCredentials')}</span>
                        <span className={styles.value}>
                            <TextCell tone={persistentCredentials ? 'accent' : 'warning'}>
                                {status.credentialsBackend}
                            </TextCell>
                            <TextCell tone="muted">
                                {t(
                                    persistentCredentials
                                        ? 'page.setting.diagCredentialsOs'
                                        : 'page.setting.diagCredentialsMemory',
                                )}
                            </TextCell>
                        </span>
                    </div>

                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.diagCounts')}</span>
                        <span className={styles.value}>
                            <TextCell tone="muted">
                                {t('page.setting.diagCountsValue', {
                                    plugins: status.counts.plugins,
                                    favorites: status.counts.favorites,
                                    tracks: status.counts.tracks,
                                    downloads: status.counts.downloads,
                                })}
                            </TextCell>
                        </span>
                    </div>
                </>
            )}

            {available && paths && (
                <>
                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.diagPaths')}</span>
                        <span className={styles.value}>
                            <code className={styles.path}>{paths.data}</code>
                            <Button size="sm" variant="ghost" onClick={() => void open(paths.data)}>
                                {t('page.setting.diagOpenData')}
                            </Button>
                        </span>
                    </div>

                    {/* 日志目录单独一行：排障时用户要「打开日志目录」而不是先找数据目录 */}
                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.diagLogsPath')}</span>
                        <span className={styles.value}>
                            <code className={styles.path}>{paths.logs}</code>
                            <Button size="sm" variant="ghost" onClick={() => void open(paths.logs)}>
                                {t('page.setting.diagOpenLogs')}
                            </Button>
                        </span>
                    </div>
                </>
            )}

            {error && <p className={styles.hint}>{t('page.setting.diagErrorHint', {reason: error})}</p>}
        </section>
    );
}
