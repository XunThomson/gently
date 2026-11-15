import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {CacheClearKind, CacheStatusDto} from '../../../api';
import {Button} from '../../../components/ui/button';
import {errorText} from '../../../i18n/errors';
import {coreAvailable, coreSystem} from '../../../services';
import {useActions} from '../../../store';
import {formatBytes} from '../../../utils/helpers';
import {ChoiceField} from './choice-field';
import {Field} from './field';
import styles from '../setting.module.css';

/**
 * 缓存上限的几档固定值（256 MiB ~ 8 GiB）。
 *
 * 为什么不做「任意输入」：一个手滑填成 0 或 100 GB 的设置，用户自己很难判断影响；
 * 给几档够用且都在核心的合法区间（`minBytes`~`maxBytes`）内。
 */
const CACHE_LIMIT_OPTIONS = [
    256 * 1024 * 1024,
    512 * 1024 * 1024,
    1024 * 1024 * 1024,
    2 * 1024 * 1024 * 1024,
    4 * 1024 * 1024 * 1024,
    8 * 1024 * 1024 * 1024,
];

/**
 * 「存储与缓存」组里的缓存条目：占用 / 上限 / 清理。
 *
 * 缓存占用是**本机核心**的数据：桌面端挂载就查一次；浏览器预览如实说明不可用。
 * 只渲染组内条目（不再自带卡片与标题），标题由外层 `Section` 与其子块标题负责。
 */
export function CacheSettings() {
    const {t} = useTranslation();
    const {requestConfirm} = useActions().dialog;
    const cacheAvailable = coreAvailable();

    const [cache, setCache] = useState<CacheStatusDto | null>(null);
    const [cacheError, setCacheError] = useState<string | null>(null);
    const [cacheNotice, setCacheNotice] = useState<string | null>(null);
    const [cacheBusy, setCacheBusy] = useState(false);

    const refreshCache = useCallback(async () => {
        if (!cacheAvailable) return;
        const result = await coreSystem.cacheStatus();
        if (result.ok) {
            setCache(result.data);
            setCacheError(null);
        } else {
            setCacheError(errorText(t, result.error));
        }
    }, [cacheAvailable, t]);

    useEffect(() => {
        void refreshCache();
    }, [refreshCache]);

    const clearCache = useCallback(
        (kind: CacheClearKind) => {
            requestConfirm({
                titleKey: 'page.setting.cacheClearConfirm',
                descKey: 'page.setting.cacheClearDesc',
                tone: 'danger',
                onConfirm: async () => {
                    setCacheBusy(true);
                    const result = await coreSystem.cacheClear(kind);
                    setCacheBusy(false);
                    if (result.ok) {
                        setCacheNotice(
                            t('page.setting.cacheCleared', {
                                files: result.data.removedFiles,
                                size: formatBytes(result.data.removedBytes),
                            }),
                        );
                        setCacheError(null);
                        await refreshCache();
                    } else {
                        setCacheError(errorText(t, result.error));
                    }
                },
            });
        },
        [requestConfirm, refreshCache, t],
    );

    /** 改缓存上限：核心立即按新上限淘汰，返回最新占用 */
    const changeLimit = useCallback(
        async (limitBytes: number) => {
            if (!cacheAvailable) return;
            setCacheBusy(true);
            const result = await coreSystem.cacheConfig(limitBytes);
            setCacheBusy(false);
            if (result.ok) {
                setCache(result.data);
                setCacheError(null);
                setCacheNotice(t('page.setting.cacheLimitSaved'));
            } else {
                setCacheError(errorText(t, result.error));
            }
        },
        [cacheAvailable, t],
    );

    const cacheTotal = cache ? cache.mediaBytes + cache.catalogBytes + cache.coversBytes : 0;

    return (
        <>
            <div className={styles.subHeader}>
                <h3 className={styles.subTitle}>{t('page.setting.cache')}</h3>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={!cacheAvailable || cacheBusy}
                    onClick={() => void refreshCache()}
                >
                    {t('page.setting.cacheRefresh')}
                </Button>
            </div>
            <p className={styles.hint}>{t('page.setting.cacheHint')}</p>

            {!cacheAvailable ? (
                <p className={styles.hint}>{t('page.setting.cacheUnavailable')}</p>
            ) : (
                <>
                    <Field label={t('page.setting.cacheMedia')}>
                        {cache
                            ? t('page.setting.cacheUsage', {
                                size: formatBytes(cache.mediaBytes),
                                count: cache.mediaCount,
                            })
                            : '—'}
                    </Field>

                    <Field label={t('page.setting.cacheCatalog')}>
                        {cache
                            ? t('page.setting.cacheUsage', {
                                size: formatBytes(cache.catalogBytes),
                                count: cache.catalogCount,
                            })
                            : '—'}
                    </Field>

                    <Field label={t('page.setting.cacheCovers')}>
                        {cache
                            ? t('page.setting.cacheUsage', {
                                size: formatBytes(cache.coversBytes),
                                count: cache.coversCount,
                            })
                            : '—'}
                    </Field>

                    {/* 上限可选：给几档固定值，避免「随便填一个数字」把缓存配成 0 或 100 GB */}
                    <ChoiceField
                        label={t('page.setting.cacheLimit')}
                        hint={t('page.setting.cacheLimitHint')}
                        value={String(cache?.limitBytes ?? '')}
                        onChange={(value) => void changeLimit(Number(value))}
                        options={CACHE_LIMIT_OPTIONS.map((bytes) => ({
                            value: String(bytes),
                            label: formatBytes(bytes),
                        }))}
                    />

                    <div className={styles.actionRow}>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={cacheBusy || (cache?.mediaCount ?? 0) === 0}
                            onClick={() => clearCache('media')}
                        >
                            {t('page.setting.cacheClearMedia')}
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={cacheBusy || (cache?.catalogCount ?? 0) === 0}
                            onClick={() => clearCache('catalog')}
                        >
                            {t('page.setting.cacheClearCatalog')}
                        </Button>
                        <Button
                            size="sm"
                            variant="danger"
                            disabled={cacheBusy || cacheTotal === 0}
                            onClick={() => clearCache('all')}
                        >
                            {t('page.setting.cacheClearAll')}
                        </Button>
                    </div>

                    {cacheNotice && <p className={styles.notice}>{cacheNotice}</p>}
                    {cacheError && <p className={styles.notice}>{cacheError}</p>}
                </>
            )}
        </>
    );
}

export default CacheSettings;
