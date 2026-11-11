import {useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Button} from '../../../components/ui/button';
import {IconChevronDown, IconFolder} from '../../../components/ui/icon';
import {coreAvailable, importAudioDirectory, importAudioFiles, importProgress, importedMusicDir, type ImportProgress} from '../../../services';
import {useActions, useLibraryState} from '../../../store';
import {errorText} from '../../../i18n/errors';
import {importNoteText, importProgressText, importedTracksOf} from '../../../utils/importNote';
import {isMobilePlatform} from '../../../utils/platform';
import {useConfirm} from '../../../hooks/useConfirm';
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
    const {scanning, scanProgress, scanSummary, scanError, local} = useLibraryState();
    const {scan, purgeImported} = useActions().library;
    const confirm = useConfirm();

    const [paths, setPaths] = useState('');
    const [recursive, setRecursive] = useState(true);
    const [open, setOpen] = useState(false);
    /** 手机导入是异步且可能被取消的，结果要留在界面上（说清导入了几首） */
    const [importing, setImporting] = useState(false);
    const [importNote, setImportNote] = useState('');
    /** 导入进度（R136）：拷大文件时界面不能一直停在「等待选择…」 */
    const [progress, setProgress] = useState<ImportProgress | null>(null);
    /** 导入副本的落点目录（只有手机宿主有）；`null` = 没有/还没问出来 */
    const [importDir, setImportDir] = useState<string | null>(null);
    const mobile = isMobilePlatform();

    const available = coreAvailable();
    const dirs = paths
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    /* 导入目录只问一次：同一个安装内它是不变的（`filesDir` 随包名/用户定） */
    useEffect(() => {
        if (!mobile || !available) return;
        let alive = true;
        void importedMusicDir().then((dir) => {
            if (alive) setImportDir(dir);
        });
        return () => {
            alive = false;
        };
    }, [mobile, available]);

    /* 导入副本 = 路径落在导入目录里的本地曲目（前端不猜，靠前缀匹配） */
    const importedCopies = importedTracksOf(local, importDir);

    /* 扫描是不可中断的长任务：进度必须能看见，所以一开始就展开抽屉 */
    useEffect(() => {
        if (scanning) setOpen(true);
    }, [scanning]);

    /* 导入进度（R136）：Kotlin 维护快照、这里轮询（250ms）。
       为什么轮询而不是事件：Kotlin → Rust 没有回调通道，Rust → Kotlin 才有；
       一轮导入几十次调用，代价可以忽略。导入结束就停表，不在后台常驻。 */
    useEffect(() => {
        if (!importing) {
            setProgress(null);
            return;
        }
        let alive = true;
        const timer = window.setInterval(() => {
            void importProgress().then((snapshot) => {
                if (alive) setProgress(snapshot);
            });
        }, 250);
        void importProgress().then((snapshot) => {
            if (alive) setProgress(snapshot);
        });
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, [importing]);

    const start = () => {
        if (dirs.length === 0) return;
        void scan({dirs, recursive});
    };

    /**
     * 手机：从系统文件选择器导入音频（P3）。
     *
     * 安卓上没有「粘贴路径」这条路（普通用户拿不到绝对路径），所以给一个真按钮：
     * 选文件 → Kotlin 拷进应用私有目录 → 这里拿目录去 `library.local.scan` 入库。
     */
    const pickFromDevice = async (directory: boolean) => {
        setImporting(true);
        setImportNote('');
        const result = directory ? await importAudioDirectory() : await importAudioFiles();
        setImporting(false);

        setImportNote(importNoteText(result, t));
        if (result.error || result.cancelled) return;
        if (result.dir && result.imported > 0) {
            // 导入的曲目立刻进库：用户不用再自己把路径抄进文本框
            void scan({dirs: [result.dir], recursive: true});
        }
    };

    /**
     * 清理导入副本（R119）：连磁盘文件一起删，只动导入目录里的那些。
     *
     * 必须走二次确认：这是**删除文件**，与「移出曲库」不是一回事。
     */
    const cleanImported = () => {
        confirm({
            titleKey: 'confirm.purgeImportedTitle',
            descKey: 'confirm.purgeImportedDesc',
            descParams: {count: importedCopies.length},
            tone: 'danger',
            onConfirm: async () => {
                const removed = await purgeImported();
                setImportNote(t('page.local.cleanedImported', {count: removed}));
            },
        });
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
          : /* 手机上没有「填写音乐目录」这回事，提示语也不能那样写（R121 用户反馈） */
            mobile
            ? t('page.local.scanBriefIdleMobile')
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
                    {/* 手机：系统的文件选择器才是正常路径（安卓上「粘贴绝对路径」普通用户做不到） */}
                    {mobile && (
                        <div className={styles.scanRow}>
                            <div className={styles.scanControls}>
                                <Button
                                    variant="primary"
                                    size="sm"
                                    onClick={() => void pickFromDevice(false)}
                                    disabled={importing || scanning}
                                >
                                    {importing
                                        ? t('page.local.importing')
                                        : t('page.local.importFromDevice')}
                                </Button>
                                {/* 文件多时一个个勾太累：选一个目录，原生递归扫描后整批导入（R139） */}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => void pickFromDevice(true)}
                                    disabled={importing || scanning}
                                >
                                    {t('page.local.importDirectory')}
                                </Button>
                                {/* 导入是拷一份：占双份空间，得让用户能把副本清掉（R119） */}
                                {importedCopies.length > 0 && (
                                    <>
                                        <span className={styles.scanStatus}>
                                            {t('page.local.importedCopies', {
                                                count: importedCopies.length,
                                            })}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={cleanImported}
                                            disabled={importing || scanning}
                                        >
                                            {t('page.local.cleanImported')}
                                        </Button>
                                    </>
                                )}
                                {/* 拷大文件时要有「到哪了」：进度优先，没有进度才退回「等待选择…」 */}
                                {importing && progress?.active && (
                                    <span className={styles.scanStatus}>
                                        {importProgressText(progress, t)}
                                    </span>
                                )}
                                {importNote && <span className={styles.scanStatus}>{importNote}</span>}
                            </div>
                            <p className={styles.scanHint}>{t('page.local.importHint')}</p>
                        </div>
                    )}

                    {/* 「每行一个目录」是本机路径输入：手机上没有可粘贴的绝对路径，
                        这一块整块不显示（R121 用户反馈「目录路径这类桌面专有项」） */}
                    {!mobile && (
                        <>
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
                        </>
                    )}

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
