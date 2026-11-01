import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Button} from '../../../components/ui/button';
import {IconChevronDown, IconFolder} from '../../../components/ui/icon';
import {coreAvailable} from '../../../services';
import {useActions, useLibraryState} from '../../../store';
import {errorText} from '../../../i18n/errors';
import styles from '../local.module.css';

/**
 * 本地曲库扫描面板（**抽屉**）。
 *
 * 为什么必须有：`library.local.scan` 是**唯一**把音乐加进本地曲库的入口——
 * 没有它，桌面上的「本地音乐」永远是空的，用户会以为这个功能不存在。
 *
 * 为什么必须是抽屉：这块表单（多行路径输入 + 勾选 + 说明）常驻会把列表挤到很下面，
 * 一进页面几乎看不到歌单本体。默认收起、标题行显示「上次扫描」的结论，一次点击才展开。
 * 扫描进行中会**自动展开**（进度不能因为用户收起而看不见）。
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
    const [open, setOpen] = useState(false);

    const available = coreAvailable();
    const dirs = paths
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    /* 扫描是不可中断的长任务：进度必须能看见，所以一开始就展开抽屉 */
    useEffect(() => {
        if (scanning) setOpen(true);
    }, [scanning]);

    const start = () => {
        if (dirs.length === 0) return;
        void scan({dirs, recursive});
    };

    if (!available) {
        return <p className={styles.scanHint}>{t('page.local.scanNeedsDesktop')}</p>;
    }

    /** 收起时标题行右侧那一句：优先显示进行中的进度，其次上次结果 */
    const brief = scanning
        ? scanProgress
            ? t('page.local.scanBriefRunning', {
                  found: scanProgress.found,
                  ...(scanProgress.percent === undefined ? {} : {percent: scanProgress.percent}),
              })
            : t('page.local.scanPreparing')
        : scanSummary
          ? t('page.local.scanBriefResult', {
                scanned: scanSummary.scanned,
                added: scanSummary.added,
            })
          : t('page.local.scanBriefIdle');

    return (
        <section className={styles.scan} data-open={open}>
            <button
                type="button"
                className={styles.scanTrigger}
                aria-expanded={open}
                onClick={() => setOpen((prev) => !prev)}
            >
                <span className={styles.scanTriggerIcon} aria-hidden="true">
                    <IconFolder size={14}/>
                </span>
                <span className={styles.scanTitle}>{t('page.local.scanTitle')}</span>
                <span className={styles.scanBrief}>{brief}</span>
                <IconChevronDown
                    size={14}
                    className={`${styles.scanChevron}${open ? ` ${styles.scanChevronOpen}` : ''}`}
                />
            </button>

            {/* 抽屉本体：`grid-template-rows` 0fr → 1fr，收起时不占高度也不留白 */}
            <div className={styles.scanBody}>
                <div className={styles.scanInner}>
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
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={start}
                                disabled={scanning || dirs.length === 0}
                            >
                                {scanning ? t('page.local.scanRunningShort') : t('page.local.scanStart')}
                            </Button>
                        </div>
                    </div>

                    <p className={styles.scanHint}>{t('page.local.scanHint')}</p>

                    {/* 进度：扫大目录可能几十秒，没有反馈就是「卡住了」 */}
                    {scanning && scanProgress && (
                        <p className={styles.scanStatus}>
                            {scanProgress.percent === undefined
                                ? t('page.local.scanRunning', {
                                      dir: scanProgress.dir,
                                      found: scanProgress.found,
                                  })
                                : t('page.local.scanRunningPercent', {
                                      dir: scanProgress.dir,
                                      found: scanProgress.found,
                                      percent: scanProgress.percent,
                                  })}
                        </p>
                    )}
                    {scanning && !scanProgress && (
                        <p className={styles.scanStatus}>{t('page.local.scanPreparing')}</p>
                    )}

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
                                ignored: scanSummary.ignored,
                            })}
                        </p>
                    )}

                    {/* 失败原因按错误码本地化（`library.scan_failed` 之类），不显示开发者字符串 */}
                    {!scanning && scanError && (
                        <p className={styles.scanError}>{errorText(t, scanError)}</p>
                    )}
                </div>
            </div>
        </section>
    );
}

export default ScanPanel;
