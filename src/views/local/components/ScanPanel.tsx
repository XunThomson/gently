import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Button} from '../../../components/ui/button';
import {coreAvailable} from '../../../services';
import {useActions, useLibraryState} from '../../../store';
import {errorText} from '../../../i18n/errors';
import styles from '../local.module.css';

/**
 * 本地曲库扫描面板。
 *
 * 为什么必须在页面上（而不是藏在设置里）：`library.local.scan` 是**唯一的入库入口**——
 * 没有它，桌面上「本地音乐」永远是空的，用户会以为这个功能不存在。
 *
 * 路径用**手填/粘贴**而不是系统文件选择器：原生文件选择器要 `tauri-plugin-dialog`，
 * 它不在本机离线 crate 缓存里（与 MSI/WiX 同一类环境限制），因此这里如实告诉用户粘贴路径，
 * 而不是给一个点了没反应的按钮。
 *
 * 一次可以填多个目录（每行一个）：核心的 `dirs` 本身就是数组。
 */
export function ScanPanel() {
    const {t} = useTranslation();
    const {scanning, scanProgress, scanSummary, scanError} = useLibraryState();
    const {scan} = useActions().library;

    const [paths, setPaths] = useState('');
    const [recursive, setRecursive] = useState(true);

    const available = coreAvailable();
    const dirs = paths
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const start = () => {
        if (dirs.length === 0) return;
        void scan({dirs, recursive});
    };

    if (!available) {
        return (
            <section className={styles.scanCard}>
                <h2 className={styles.scanTitle}>{t('page.local.scanTitle')}</h2>
                <p className={styles.scanHint}>{t('page.local.scanNeedsDesktop')}</p>
            </section>
        );
    }

    return (
        <section className={styles.scanCard}>
            <h2 className={styles.scanTitle}>{t('page.local.scanTitle')}</h2>

            <div className={styles.scanRow}>
                <textarea
                    className={styles.scanInput}
                    value={paths}
                    rows={2}
                    spellCheck={false}
                    placeholder={t('page.local.scanPlaceholder')}
                    onChange={(event) => setPaths(event.target.value)}
                    disabled={scanning}
                />
                <div className={styles.scanControls}>
                    <label className={styles.scanToggle}>
                        <input
                            type="checkbox"
                            checked={recursive}
                            onChange={(event) => setRecursive(event.target.checked)}
                            disabled={scanning}
                        />
                        {t('page.local.scanRecursive')}
                    </label>
                    <Button variant="primary" size="sm" onClick={start} disabled={scanning || dirs.length === 0}>
                        {scanning ? t('page.local.scanRunningShort') : t('page.local.scanStart')}
                    </Button>
                </div>
            </div>

            <p className={styles.scanHint}>{t('page.local.scanHint')}</p>

            {/* 进度：扫大目录可能几十秒，没有反馈就是「卡住了」 */}
            {scanning && scanProgress && (
                <p className={styles.scanStatus}>
                    {scanProgress.percent === undefined
                        ? t('page.local.scanRunning', {dir: scanProgress.dir, found: scanProgress.found})
                        : t('page.local.scanRunningPercent', {
                              dir: scanProgress.dir,
                              found: scanProgress.found,
                              percent: scanProgress.percent,
                          })}
                </p>
            )}
            {scanning && !scanProgress && <p className={styles.scanStatus}>{t('page.local.scanPreparing')}</p>}

            {/* 结果：说清这次扫描到底做了什么，比「完成」有用 */}
            {!scanning && scanSummary && (
                <p className={styles.scanStatus}>
                    {t('page.local.scanResult', {
                        scanned: scanSummary.scanned,
                        added: scanSummary.added,
                        updated: scanSummary.updated,
                        removed: scanSummary.removed,
                        skipped: scanSummary.skipped,
                        unreadable: scanSummary.unreadable,
                    })}
                </p>
            )}

            {/* 失败原因按错误码本地化（`library.scan_failed` 之类），不显示开发者字符串 */}
            {!scanning && scanError && (
                <p className={styles.scanError}>{errorText(t, scanError)}</p>
            )}
        </section>
    );
}

export default ScanPanel;
