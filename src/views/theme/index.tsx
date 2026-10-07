import {useEffect, useMemo, useRef, useState} from 'react';
import type {ChangeEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {Page} from '../../components/ui/page';
import {Button} from '../../components/ui/button';
import {EmptyState} from '../../components/ui/empty-state';
import {IconTrash} from '../../components/ui/icon';
import {useConfirm} from '../../hooks/useConfirm';
import {parseSkin, useTheme} from '../../theme';
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

    const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        /* 先清空 value，保证同一个文件可以被再次导入 */
        input.value = '';
        if (!file) return;

        const result = parseSkin(await file.text());
        if (result.ok && result.skin) {
            installSkin(result.skin);
            setStatus(t('skin.imported', {name: result.skin.name}));
            return;
        }
        setStatus(t('skin.importFailed', {reason: result.reason ?? ''}));
    };

    const handleExport = () => {
        const blob = new Blob([exportSkin()], {type: 'application/json'});
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
                    <Button size="sm" onClick={() => fileRef.current?.click()}>
                        {t('skin.import')}
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
