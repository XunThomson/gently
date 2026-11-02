import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {DataDirInfoDto, DataDirMigrationDto} from '../../../api';
import {Button} from '../../../components/ui/button';
import {TextCell} from '../../../components/ui/data-table';
import {useConfirm} from '../../../hooks/useConfirm';
import {errorText} from '../../../i18n/errors';
import {coreAvailable, coreSystem, hostRestartApp} from '../../../services';
import {formatBytes} from '../../../utils/helpers';
import styles from '../setting.module.css';

/**
 * 「数据目录」卡片（R87）。
 *
 * 要解决的具体痛点：默认数据目录在用户目录（`%APPDATA%` 下），
 * 资源紧张或对系统盘有洁癖的用户希望能换个位置（比如 D 盘），而以前只能自己搬文件、
 * 应用下次启动还照样去老地方找。
 *
 * 三条边界，界面上必须说清楚：
 * 1. **只拷贝、不删除**：旧目录原样留着，用户确认新位置能用之后自己删；
 * 2. **重启生效**：数据库连接已经打开，换根目录不能热切——迁完给一个「立即重启」按钮；
 * 3. **便携版默认跟着 exe 走**（exe 同目录放一个 `portable.txt` 即可），
 *    因此这里如实显示「数据目录是怎么定下来的」，而不是只说一个路径。
 */
export function DataDirCard({mobile = false}: {mobile?: boolean}) {
    const {t} = useTranslation();
    const confirm = useConfirm();
    const available = coreAvailable();

    const [info, setInfo] = useState<DataDirInfoDto | null>(null);
    const [target, setTarget] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [moved, setMoved] = useState<DataDirMigrationDto | null>(null);

    const refresh = useCallback(async () => {
        const result = await coreSystem.dataDir();
        setInfo(result.ok ? result.data : null);
    }, []);

    useEffect(() => {
        if (available) void refresh();
    }, [available, refresh]);

    const sourceText = (() => {
        if (!info) return '';
        switch (info.source) {
            case 'portable':
                return t('page.setting.dataDirSourcePortable');
            case 'pointer':
                return t('page.setting.dataDirSourcePointer');
            case 'override':
                return t('page.setting.dataDirSourceOverride');
            default:
                return t('page.setting.dataDirSourceDefault');
        }
    })();

    const move = () => {
        const value = target.trim();
        if (!value) {
            setError(t('page.setting.dataDirNeedTarget'));
            return;
        }
        confirm({
            titleKey: 'confirm.dataDirMoveTitle',
            descKey: 'confirm.dataDirMoveDesc',
            descParams: {path: value},
            onConfirm: () => {
                void (async () => {
                    setBusy(true);
                    setError(null);
                    setMoved(null);
                    const result = await coreSystem.dataDirMove(value);
                    setBusy(false);
                    if (!result.ok) {
                        setError(errorText(t, result.error));
                        return;
                    }
                    setMoved(result.data);
                    setTarget('');
                    await refresh();
                })();
            },
        });
    };

    /* 手机：目录由系统分配在应用私有目录，**不能迁**也没有「打开文件夹」——
       只如实说一句，不给一个点了没反应的迁移表单（R121 用户反馈 / GOTCHAS §46）。
       这一支放在「没有核心」之前：手机上有没有核心都不影响这条事实。 */
    if (mobile) {
        return (
            <section className={styles.card}>
                <h2 className={styles.cardTitle}>{t('page.setting.dataDirTitle')}</h2>
                <p className={styles.hint}>{t('page.setting.dataDirMobileHint')}</p>
            </section>
        );
    }

    if (!available) {
        return (
            <section className={styles.card}>
                <h2 className={styles.cardTitle}>{t('page.setting.dataDirTitle')}</h2>
                <p className={styles.hint}>{t('page.setting.dataDirUnavailable')}</p>
            </section>
        );
    }

    return (
        <section className={styles.card}>
            <h2 className={styles.cardTitle}>{t('page.setting.dataDirTitle')}</h2>
            <p className={styles.hint}>{t('page.setting.dataDirHint')}</p>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.setting.dataDirCurrent')}</span>
                <span className={styles.value}>
                    <TextCell tone="muted">{info?.current ?? t('common.loading')}</TextCell>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => info && void coreSystem.reveal(info.current)}
                    >
                        {t('page.setting.dataDirOpen')}
                    </Button>
                </span>
            </div>

            <div className={styles.field}>
                <span className={styles.label}>{t('page.setting.dataDirSource')}</span>
                <span className={styles.value}>
                    <TextCell tone="muted">{sourceText}</TextCell>
                </span>
            </div>

            {/* 默认位置与当前位置不同时才需要显示：迁移过的用户要能一眼看出「本来的」在哪 */}
            {info && info.defaultBase !== info.current && (
                <div className={styles.field}>
                    <span className={styles.label}>{t('page.setting.dataDirDefaultBase')}</span>
                    <span className={styles.value}>
                        <TextCell tone="muted">{info.defaultBase}</TextCell>
                    </span>
                </div>
            )}

            {info?.portable && <p className={styles.hint}>{t('page.setting.dataDirPortableHint')}</p>}

            <div className={styles.field}>
                <span className={styles.label}>{t('page.setting.dataDirTarget')}</span>
                <span className={styles.value}>
                    <input
                        className={styles.input}
                        type="text"
                        value={target}
                        placeholder={t('page.setting.dataDirTargetPlaceholder')}
                        aria-label={t('page.setting.dataDirTarget')}
                        onChange={(event) => setTarget(event.target.value)}
                    />
                    <Button size="sm" variant="primary" disabled={busy} onClick={move}>
                        {busy ? t('page.setting.dataDirMoving') : t('page.setting.dataDirMove')}
                    </Button>
                </span>
            </div>
            <p className={styles.hint}>{t('page.setting.dataDirMoveHint')}</p>

            {error && <TextCell tone="danger">{error}</TextCell>}

            {/* 迁移成功：说清「重启生效、旧目录保留、删不删随你」 */}
            {moved && (
                <>
                    <TextCell tone="success">
                        {t('page.setting.dataDirMoved', {
                            path: moved.target,
                            files: moved.copiedFiles,
                            size: formatBytes(moved.copiedBytes),
                        })}
                    </TextCell>
                    <p className={styles.hint}>{t('page.setting.dataDirKept', {path: moved.sourceKept})}</p>
                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.dataDirRestart')}</span>
                        <span className={styles.value}>
                            <Button size="sm" variant="primary" onClick={() => void hostRestartApp()}>
                                {t('page.setting.dataDirRestartAction')}
                            </Button>
                        </span>
                    </div>
                </>
            )}
        </section>
    );
}

export default DataDirCard;
