import {useEffect, useMemo, useRef, useState} from 'react';
import type {ChangeEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {Button} from '../../components/ui/button';
import {UnderlineRadioGroup} from '../../components/ui/radio-group';
import {EmptyState} from '../../components/ui/empty-state';
import {IconTrash} from '../../components/ui/icon';
import {useConfirm} from '../../hooks/useConfirm';
import {errorText} from '../../i18n/errors';
import {skinService} from '../../services';
import {useTheme} from '../../theme';
import type {ThemeSkin} from '../../theme';
import {matchesQuery} from '../../utils/helpers';
import styles from './theme.module.css';

/** 导入 / 删除后的提示停留时长 */
const STATUS_TIMEOUT = 2500;

/**
 * 主题市场（皮肤市场）：浏览 / 搜索 / 标签筛选内置与自定义皮肤，
 * 并支持导入、导出、删除皮肤。
 *
 * 皮肤状态集中在 `ThemeProvider`（store 的 ui 切片），本视图只保留
 * 搜索词 / 选中标签 / 临时提示三类局部交互状态。
 */
export default function ThemeView() {
    const {t} = useTranslation();
    const {presetId, setPreset, skins, skin, installSkin, removeSkin, exportSkin} = useTheme();
    const confirm = useConfirm();

    const [query, setQuery] = useState('');
    const [activeTag, setActiveTag] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    /**
     * 导入面板：**粘贴 JSON / 粘贴本机路径 / 原生文件选择器**三条来源。
     *
     * 为什么不能只有文件选择器：桌面端没有 Tauri 的 dialog 插件，`<input type=file>` 那扇
     * 原生选择器在自动化环境里驱动不了（R49 实测：点得开、按钮点不动），而插件页早就用
     * 「粘贴文本 / 粘贴路径」解决了同一个问题——皮肤没有理由更差。核心侧 `skin.preview/install`
     * 收的就是同一个 `ImportSource`，所以这三条来源只是同一能力的三种入口。
     */
    const [importing, setImporting] = useState(false);
    const [sourceMode, setSourceMode] = useState<'json' | 'path'>('json');
    const [sourceText, setSourceText] = useState('');
    const [busy, setBusy] = useState(false);

    /* 提示自动消失：定时器只在 effect 内注册，SSR 下不会执行 */
    useEffect(() => {
        if (!status) return;
        const timer = setTimeout(() => setStatus(null), STATUS_TIMEOUT);
        return () => clearTimeout(timer);
    }, [status]);

    /* 全部皮肤标签的并集（仅当至少一个皮肤带标签时才展示筛选行） */
    const tags = useMemo(() => {
        const union = new Set<string>();
        skins.forEach((item) => item.tags?.forEach((tag) => union.add(tag)));
        return [...union];
    }, [skins]);

    /* 选中的标签被删除后回落到「全部」，避免网格卡在空态 */
    useEffect(() => {
        if (activeTag && !tags.includes(activeTag)) setActiveTag(null);
    }, [activeTag, tags]);

    const visibleSkins = useMemo(
        () =>
            skins.filter(
                (item) =>
                    (!activeTag || item.tags?.includes(activeTag)) &&
                    matchesQuery(item.name, item.description, item.author, query),
            ),
        [skins, activeTag, query],
    );

    /** 导入结果的统一收尾：成功就装上并提示，失败按「被拒键名 / 错误码 / 原因」逐级说清 */
    const applyOutcome = (
        outcome: Awaited<ReturnType<typeof skinService.importFromText>>,
    ): void => {
        if (outcome.ok && outcome.skin) {
            installSkin(outcome.skin);
            setStatus(t('skin.imported', {name: outcome.skin.name}));
            setSourceText('');
            setImporting(false);
            return;
        }
        setStatus(
            outcome.rejectedKeys && outcome.rejectedKeys.length > 0
                ? t('skin.importRejected', {keys: outcome.rejectedKeys.join(', ')})
                : outcome.code
                  ? errorText(t, {code: outcome.code, message: outcome.reason ?? ''})
                  : t('skin.importFailed', {reason: outcome.reason ?? ''}),
        );
    };

    /** 面板里的「导入」：按当前来源（粘贴 JSON / 粘贴路径）走核心 */
    const submitSource = async () => {
        const value = sourceText.trim();
        if (!value) {
            setStatus(t('skin.importFailed', {reason: t('skin.jsonPlaceholder')}));
            return;
        }
        setBusy(true);
        try {
            applyOutcome(
                sourceMode === 'json'
                    ? await skinService.importFromText(value)
                    : await skinService.importFromPath(value),
            );
        } finally {
            setBusy(false);
        }
    };

    const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        /* 先清空 value，保证同一个文件可以被再次导入 */
        input.value = '';
        if (!file) return;

        /* 桌面端由**本机核心**校验（结构 + 令牌键名白名单）；浏览器预览用本地解析兜底 */
        applyOutcome(await skinService.importFromText(await file.text()));
    };

    const handleExport = async () => {
        const json = await exportSkin();
        const blob = new Blob([json], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${skin.id}.gently-skin.json`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const handleRemove = (target: ThemeSkin) => {
        confirm({
            titleKey: 'confirm.deleteSkinTitle',
            descKey: 'confirm.deleteSkinDesc',
            descParams: {name: target.name},
            tone: 'danger',
            onConfirm: () => {
                removeSkin(target.id);
                setStatus(t('skin.removed', {name: target.name}));
            },
        });
    };

    return (
        <Page
            title={t('page.theme.title')}
            subtitle={t('page.theme.subtitle')}
            toolbar={
                <>
                    <input
                        className={styles.search}
                        type="search"
                        value={query}
                        placeholder={t('skin.searchPlaceholder')}
                        aria-label={t('skin.searchPlaceholder')}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                    <Button size="sm" onClick={() => setImporting((prev) => !prev)}>
                        {importing ? t('skin.close') : t('skin.import')}
                    </Button>
                    <Button size="sm" onClick={handleExport}>
                        {t('skin.export')}
                    </Button>
                    <input
                        ref={fileRef}
                        className={styles.fileInput}
                        type="file"
                        accept=".json,application/json"
                        onChange={handleImport}
                    />
                </>
            }
        >
            {status && <p className={styles.status}>{status}</p>}

            {/* ---------- 导入面板：粘贴 JSON / 粘贴路径 / 原生选择器 ---------- */}
            {importing && (
                <section className={styles.importPanel}>
                    <div className={styles.importTabs}>
                        <UnderlineRadioGroup
                            name="skin-source"
                            value={sourceMode}
                            onChange={(value) => setSourceMode(value as 'json' | 'path')}
                            options={[
                                {value: 'json', label: t('skin.sourceJson')},
                                {value: 'path', label: t('skin.sourcePath')},
                            ]}
                        />
                        <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
                            {t('skin.fromFile')}
                        </Button>
                    </div>

                    {sourceMode === 'json' ? (
                        <div className={styles.importField}>
                            <span className={styles.importLabel}>{t('skin.jsonLabel')}</span>
                            <textarea
                                className={styles.importTextarea}
                                value={sourceText}
                                placeholder={t('skin.jsonPlaceholder')}
                                onChange={(event) => setSourceText(event.target.value)}
                            />
                        </div>
                    ) : (
                        <div className={styles.importField}>
                            <span className={styles.importLabel}>{t('skin.pathLabel')}</span>
                            <input
                                className={styles.importInput}
                                type="text"
                                value={sourceText}
                                placeholder={t('skin.pathPlaceholder')}
                                onChange={(event) => setSourceText(event.target.value)}
                            />
                            <p className={styles.importHint}>{t('skin.pathHint')}</p>
                        </div>
                    )}

                    <div className={styles.importActions}>
                        <Button size="sm" variant="primary" disabled={busy} onClick={() => void submitSource()}>
                            {busy ? t('skin.submitting') : t('skin.submit')}
                        </Button>
                    </div>
                </section>
            )}

            {tags.length > 0 && (
                <div className={styles.tagRow} role="group" aria-label={t('skin.tagAll')}>
                    <button
                        type="button"
                        className={[styles.chip, activeTag === null ? styles.chipActive : '']
                            .filter(Boolean)
                            .join(' ')}
                        aria-pressed={activeTag === null}
                        onClick={() => setActiveTag(null)}
                    >
                        {t('skin.tagAll')}
                    </button>
                    {tags.map((tag) => (
                        <button
                            key={tag}
                            type="button"
                            className={[styles.chip, activeTag === tag ? styles.chipActive : '']
                                .filter(Boolean)
                                .join(' ')}
                            aria-pressed={activeTag === tag}
                            onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                        >
                            {tag}
                        </button>
                    ))}
                </div>
            )}

            {visibleSkins.length === 0 ? (
                <EmptyState title={t('skin.searchPlaceholder')}/>
            ) : (
                <div className={styles.grid}>
                    {visibleSkins.map((item) => {
                        const active = item.id === presetId;

                        return (
                            <div
                                key={item.id}
                                className={[styles.card, active ? styles.cardActive : '']
                                    .filter(Boolean)
                                    .join(' ')}
                            >
                                <div className={styles.preview}>
                                    {item.swatches.map((color, index) => (
                                        <span
                                            key={`${item.id}-${index}`}
                                            className={styles.swatch}
                                            style={{background: color}}
                                        />
                                    ))}
                                </div>

                                <div className={styles.cardHead}>
                                    <span className={styles.name}>{item.name}</span>
                                    {!item.builtin && (
                                        <span className={styles.customTag}>
                                            {t('skin.customTag')}
                                        </span>
                                    )}
                                </div>

                                <span className={styles.description}>{item.description}</span>
                                <span className={styles.author}>
                                    {t('page.theme.by', {name: item.author})}
                                </span>

                                {item.tags && item.tags.length > 0 && (
                                    <div className={styles.cardTags}>
                                        {item.tags.map((tag) => (
                                            <span key={tag} className={styles.cardTag}>
                                                {tag}
                                            </span>
                                        ))}
                                    </div>
                                )}

                                <div className={styles.actions}>
                                    <Button
                                        className={styles.apply}
                                        size="sm"
                                        variant={active ? 'default' : 'primary'}
                                        disabled={active}
                                        onClick={() => setPreset(item.id)}
                                    >
                                        {t(active ? 'page.theme.applied' : 'page.theme.apply')}
                                    </Button>

                                    {!item.builtin && (
                                        <Button
                                            className={styles.remove}
                                            size="sm"
                                            variant="danger"
                                            icon={<IconTrash size={14}/>}
                                            onClick={() => handleRemove(item)}
                                        >
                                            {t('skin.remove')}
                                        </Button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </Page>
    );
}
