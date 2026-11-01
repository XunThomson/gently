import {useEffect, useMemo, useRef, useState} from 'react';
import type {ChangeEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {Button} from '../../components/ui/button';
import {UnderlineRadioGroup} from '../../components/ui/radio-group';
import {EmptyState} from '../../components/ui/empty-state';
import {IconTrash} from '../../components/ui/icon';
import {useConfirm} from '../../hooks/useConfirm';
import {useSkinBackground} from '../../hooks/useSkinBackground';
import {errorText} from '../../i18n/errors';
import {coreSystem, isTauri, skinService} from '../../services';
import {useTheme} from '../../theme';
import type {ThemeSkin} from '../../theme';
import {copyText} from '../../utils/clipboard';
import {matchesQuery} from '../../utils/helpers';
import {backgroundKindOfFile, pickSkinPackageFiles} from '../../utils/skinPackage';
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

    /* 主题包背景：导入时绑定素材，切主题时自动应用（见 hooks/useSkinBackground） */
    const {bindSkinBackground, applySkinBackground} = useSkinBackground();

    /**
     * 切到另一套皮肤时**自动应用它的背景**。
     *
     * 首次挂载刻意跳过：`ui.background` 里是用户上次的微调结果，
     * 启动时拿皮肤的默认值把它盖掉，等于每次开应用都把用户的调整抹掉一次。
     */
    const lastSkinId = useRef<string | null>(null);
    useEffect(() => {
        if (lastSkinId.current === null) {
            lastSkinId.current = skin.id;
            return;
        }
        if (lastSkinId.current === skin.id) return;
        lastSkinId.current = skin.id;
        void applySkinBackground(skin);
    }, [skin, applySkinBackground]);

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
        const files = Array.from(input.files ?? []);
        /* 先清空 value，保证同一个文件可以被再次导入 */
        input.value = '';
        if (files.length === 0) return;

        /* **主题包**（R87）：可以一次选中 `skin.json` + `bg.mp4`（也可以只选 JSON）。
           JSON 走原来的导入/校验链路；背景素材按皮肤 id 存进 IndexedDB 并立刻应用，
           用户不需要（也不该）再跑去设置页手动导入一遍背景。 */
        const picked = pickSkinPackageFiles(files.map((file) => file.name));
        if (!picked.json) {
            setStatus(t(picked.reason === 'ambiguous-json' ? 'skin.packageAmbiguous' : 'skin.packageNoJson'));
            return;
        }

        const jsonFile = files.find((file) => file.name === picked.json || file.name.endsWith(`/${picked.json}`) || file.name.endsWith(`\\${picked.json}`));
        const backgroundFile = picked.background
            ? files.find((file) => file.name === picked.background || file.name.endsWith(`/${picked.background}`) || file.name.endsWith(`\\${picked.background}`))
            : undefined;
        if (!jsonFile) {
            setStatus(t('skin.packageNoJson'));
            return;
        }

        /* 桌面端由**本机核心**校验（结构 + 令牌键名白名单）；浏览器预览用本地解析兜底 */
        const outcome = await skinService.importFromText(await jsonFile.text());
        applyOutcome(outcome);

        const kind = backgroundFile ? backgroundKindOfFile(backgroundFile.name) : null;
        if (!outcome.ok || !outcome.skin || !backgroundFile || !kind) return;

        if (await bindSkinBackground(outcome.skin.id, backgroundFile, kind)) {
            // 素材刚存好：可能刚才那次自动应用只拿到了参数，这里补一次（用的是同一套皮肤）
            await applySkinBackground(outcome.skin);
            setStatus(
                t('skin.packageImported', {name: outcome.skin.name, background: backgroundFile.name}),
            );
        }
    };

    /**
     * 导出当前皮肤。
     *
     * 桌面端**必须走核心落盘**：宿主没有浏览器的下载处理器，`<a download>` 点了没有任何反应
     * （R68 用户报的「导出按钮没反应」）。顺序：
     * 1. 用户皮肤 → `skin.export{format:'file'}` 写 `<data>/skins/<id>.json`，再 `system.reveal`
     *    在资源管理器里选中它；
     * 2. 内置预设（核心不认识它们）或落盘失败 → 复制 JSON 到剪贴板，并如实提示；
     * 3. 连剪贴板都失败 → 把 JSON 摊进导入面板的文本框，用户自己复制（不假装成功）。
     */
    const handleExport = async () => {
        const json = await exportSkin();

        /* 浏览器预览没有核心：锚点下载在浏览器里是可行的，保留这条路 */
        if (!isTauri()) {
            const url = URL.createObjectURL(new Blob([json], {type: 'application/json'}));
            const link = document.createElement('a');
            link.href = url;
            link.download = `${skin.id}.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            /* 立即 revoke 会把下载掐断，推到下一拍 */
            window.setTimeout(() => URL.revokeObjectURL(url), 0);
            setStatus(t('skin.exportedDownload', {name: skin.name}));
            return;
        }

        const path = skin.builtin === false ? await skinService.exportToFile(skin.id) : null;
        if (path) {
            await coreSystem.reveal(path);
            setStatus(t('skin.exportedToFile', {name: skin.name}));
            return;
        }

        if (await copyText(json)) {
            setStatus(t('skin.exportCopied', {name: skin.name}));
            return;
        }

        /* 最后的兜底：把内容摊开（导入面板的文本框）让用户手动复制 */
        setSourceMode('json');
        setSourceText(json);
        setImporting(true);
        setStatus(t('skin.exportCopyFailed'));
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
                        /* 主题包：一个 JSON（必需）+ 一个背景素材（可选，视频或单文件网页） */
                        multiple
                        accept=".json,application/json,.mp4,.webm,.m4v,.ogg,.html,.htm"
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
                                    {/* 缺色卡的用户皮肤（合法文档）不该把整页打成错误边界 */}
                                    {(item.swatches ?? []).map((color, index) => (
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
