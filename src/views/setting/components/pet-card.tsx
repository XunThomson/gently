import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {PetStateDto} from '../../../services/core.pet';
import {Button} from '../../../components/ui/button';
import {UnderlineRadioGroup} from '../../../components/ui/radio-group/UnderlineRadioGroup';
import {BadgeCell, TextCell} from '../../../components/ui/data-table';
import {useConfirm} from '../../../hooks/useConfirm';
import {errorText} from '../../../i18n/errors';
import {petService, windowService} from '../../../services';
import {PET_PROFILE_EVENT, PET_ROAM_EVENT, PET_SIZE_EVENT} from '../../../services/window.service';
import type {PetSize} from '../../../utils/petPresentation';
import {useActions} from '../../../store';
import styles from '../setting.module.css';
import {PetPreview} from './pet-preview';
import {PetDebugPanel} from './pet-debug';

/**
 * 宠物管理（实验，M2）：列表 / 切换 / 卸载 / 导入宠物包。
 *
 * 三条边界：
 * 1. **包是数据不是代码**：`pet.json` + 可选图集（png/webp），没有脚本；解析与校验都在核心里
 *    （前端不预解析——否则「前端说合法、核心说非法」会变成两种真相）；
 * 2. **单宠物展示**：存储能放多只（将来独立化要用），但同一时刻只有一只出战；
 * 3. **默认关**：这是 2.x 的形态，1.x 里只有这个「实验」入口，关掉即卸载渲染器。
 */
export function PetCard({enabled, onToggle}: {enabled: boolean; onToggle: (next: boolean) => void}) {
    const {t} = useTranslation();
    const confirm = useConfirm();
    const {bumpPetRevision} = useActions().ui;

    const [state, setState] = useState<PetStateDto | null>(null);
    const [available, setAvailable] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [importing, setImporting] = useState(false);
    /** 拖文件时高亮投放区（纯视觉，不影响安装逻辑） */
    const [dragging, setDragging] = useState(false);
    /** 点击穿透（锁定宠物窗口）：状态存 localStorage，与桌面歌词同款 */
    const [locked, setLocked] = useState<boolean>(() => windowService.petLocked());
    /** 是否允许宠物在屏幕上走动（默认关：它会自己挪窗口） */
    const [roam, setRoam] = useState<boolean>(() => windowService.petRoam());
    const [petSize, setPetSize] = useState<PetSize>(() => windowService.petSize());
    const [specText, setSpecText] = useState('');
    const [atlasFile, setAtlasFile] = useState<File | null>(null);

    const refresh = useCallback(async () => {
        const result = await petService.state();
        if (!result.ok) {
            setAvailable(result.error?.code !== 'common.unsupported_platform');
            setState(null);
            return;
        }
        setAvailable(true);
        setState(result.data ?? null);
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        let disposed = false;
        const unlisteners: (() => void)[] = [];
        void (async () => {
            try {
                const {listen} = await import('@tauri-apps/api/event');
                const offSize = await listen<{size: PetSize}>(PET_SIZE_EVENT, (event) => setPetSize(event.payload.size));
                const offRoam = await listen<{enabled: boolean}>(PET_ROAM_EVENT, (event) => setRoam(event.payload.enabled));
                const offProfile = await listen(PET_PROFILE_EVENT, () => void refresh());
                if (disposed) {
                    offSize();
                    offRoam();
                    offProfile();
                } else {
                    unlisteners.push(offSize, offRoam, offProfile);
                }
            } catch {
                /* 浏览器预览没有窗口事件总线 */
            }
        })();
        return () => {
            disposed = true;
            for (const unlisten of unlisteners) unlisten();
        };
    }, []);

    const run = async (
        action: () => Promise<{ok: boolean; error?: {code: string; message: string}}>,
        remount = true,
    ) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        const result = await action();
        setBusy(false);
        if (!result.ok) {
            /* 错误码 → 本地化文案；核心的 `message` 是给开发者看的中文说明，不直接显示 */
            setError(result.error ? errorText(t, result.error) : t('page.setting.petDebugFailed'));
            return false;
        }
        await refresh();
        if (remount) bumpPetRevision();
        else windowService.notifyPetProfileChanged();
        return true;
    };

    /** 点击穿透开关：写 localStorage 并立刻作用到宠物窗口 */
    const toggleLock = async (next: boolean) => {
        const applied = await windowService.setPetLocked(next);
        setLocked(applied);
    };

    /** 走动开关：持久化 + 立刻告诉宿主 */
    const toggleRoam = (next: boolean) => {
        windowService.setPetRoam(next);
        setRoam(next);
    };

    /** 拖进来的文件：`.json` 当规格文本，`.png/.webp` 当图集；其它类型忽略 */
    const dropFiles = async (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(false);
        const files = [...event.dataTransfer.files];
        if (files.length === 0) return;
        for (const file of files) {
            const name = file.name.toLowerCase();
            if (name.endsWith('.json') || file.type === 'application/json') {
                setSpecText(await file.text());
            } else if (name.endsWith('.png') || name.endsWith('.webp') || file.type.startsWith('image/')) {
                setAtlasFile(file);
            }
        }
    };

    const importPackage = async () => {
        const spec = specText.trim();
        if (!spec) {
            setError(t('page.setting.petNeedSpec'));
            return;
        }
        let atlas: {file: string; dataBase64: string} | undefined;
        if (atlasFile) {
            // 图集走 base64：命令参数是 JSON，直接传字节不现实（核心侧上限 8 MiB）
            const buffer = new Uint8Array(await atlasFile.arrayBuffer());
            let binary = '';
            for (const byte of buffer) binary += String.fromCharCode(byte);
            atlas = {file: atlasFile.name, dataBase64: btoa(binary)};
        }
        const ok = await run(() =>
            petService.install(spec, atlas).then((result) =>
                result.ok
                    ? {ok: true}
                    : {ok: false, error: result.error ?? {code: 'pet.internal', message: 'install failed'}},
            ),
        );
        if (!ok) return;
        setSpecText('');
        setAtlasFile(null);
        setImporting(false);
        setNotice(t('page.setting.petImported'));
    };

    const pets = state?.pets ?? [];

    return (
        <>
            <div className={styles.field}>
                <span className={styles.label}>
                    {t('page.setting.petToggle')}{' '}
                    <TextCell tone="muted">{t('page.setting.petBeta')}</TextCell>
                </span>
                <span className={styles.value}>
                    {/* 与其它设置项一致的「下划线单选」：显示的是**当前状态**，点另一个才是动作。
                        以前用的是单个按钮，标签是状态但看起来像动作（语义与功能不符）。 */}
                    <UnderlineRadioGroup
                        name="pet-enabled"
                        value={enabled ? 'on' : 'off'}
                        onChange={(value) => onToggle(value === 'on')}
                        options={[
                            {value: 'on', label: t('common.enable')},
                            {value: 'off', label: t('common.disable')},
                        ]}
                    />
                </span>
            </div>
            <p className={styles.hint}>
                {available ? t('page.setting.petHint') : t('page.setting.petNeedsDesktop')}
            </p>

            {available && (
                <>
                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.petLock')}</span>
                        <span className={styles.value}>
                            <UnderlineRadioGroup
                                name="pet-locked"
                                value={locked ? 'on' : 'off'}
                                onChange={(value) => void toggleLock(value === 'on')}
                                options={[
                                    {value: 'on', label: t('common.enable')},
                                    {value: 'off', label: t('common.disable')},
                                ]}
                            />
                        </span>
                    </div>
                    <p className={styles.hint}>{t('page.setting.petLockHint')}</p>

                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.petSize')}</span>
                        <span className={styles.value}>
                            <UnderlineRadioGroup
                                name="pet-size"
                                value={petSize}
                                onChange={(value) => {
                                    const next = value as PetSize;
                                    windowService.setPetSize(next);
                                    setPetSize(next);
                                }}
                                options={[
                                    {value: 'small', label: t('pet.size.small')},
                                    {value: 'medium', label: t('pet.size.medium')},
                                    {value: 'large', label: t('pet.size.large')},
                                ]}
                            />
                        </span>
                    </div>

                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.petRoam')}</span>
                        <span className={styles.value}>
                            <UnderlineRadioGroup
                                name="pet-roam"
                                value={roam ? 'on' : 'off'}
                                onChange={(value) => toggleRoam(value === 'on')}
                                options={[
                                    {value: 'on', label: t('common.enable')},
                                    {value: 'off', label: t('common.disable')},
                                ]}
                            />
                        </span>
                    </div>
                    <p className={styles.hint}>{t('page.setting.petRoamHint')}</p>

                    <div className={styles.field}>
                        <span className={styles.label}>{t('page.setting.petInstalled')}</span>
                        <span className={styles.value}>
                            <TextCell tone="muted">
                                {pets.length === 0
                                    ? t('page.setting.petNone')
                                    : t('page.setting.petCount', {count: pets.length})}
                            </TextCell>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
                                {t('common.refresh')}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setImporting((prev) => !prev)}>
                                {importing ? t('page.setting.petImportClose') : t('page.setting.petImport')}
                            </Button>
                        </span>
                    </div>

                    {pets.length > 0 && (
                        <ul className={styles.petList}>
                            {pets.map((pet) => (
                                <li key={pet.id} className={styles.petRow}>
                                    <PetPreview spec={pet.spec} petId={pet.id}/>
                                    <span className={styles.petRowLabel}>
                                        <TextCell>{pet.name}</TextCell>
                                        <TextCell tone="muted">v{pet.version}</TextCell>
                                        <BadgeCell tone={pet.active ? 'success' : 'muted'}>
                                            {pet.active ? t('page.setting.petActive') : t('page.setting.petIdle')}
                                        </BadgeCell>
                                        <TextCell tone="muted">
                                            {t('page.setting.petAffection', {value: pet.profile.affection})}
                                        </TextCell>
                                        <TextCell tone="muted">
                                            {t('pet.status.level', {level: pet.growth?.level ?? 1})}
                                        </TextCell>
                                        <TextCell tone="muted">
                                            {t('pet.status.xp', {
                                                xp: pet.growth?.xp ?? 0,
                                                next: pet.growth?.nextLevelXp ?? 0,
                                            })}
                                        </TextCell>
                                        {(pet.growth?.streakDays ?? 0) > 0 && (
                                            <TextCell tone="muted">
                                                {t('pet.status.streak', {
                                                    days: pet.growth?.streakDays ?? 0,
                                                })}
                                            </TextCell>
                                        )}
                                        <TextCell tone="muted">
                                            {t(`pet.mood.${pet.mood}`)}
                                        </TextCell>
                                        {pet.hungry && (
                                            <BadgeCell tone="warning">{t('page.setting.petHungry')}</BadgeCell>
                                        )}
                                    </span>
                                    <span className={styles.petRowActions}>
                                        <Button
                                            size="sm"
                                            variant={pet.hungry ? 'primary' : 'ghost'}
                                            disabled={busy}
                                            onClick={() =>
                                                void run(async () => {
                                                    const result = await petService.interact(pet.id, 'feed');
                                                    return result.ok
                                                        ? {ok: true}
                                                        : {
                                                            ok: false,
                                                            error: result.error ?? {
                                                                code: 'pet.internal',
                                                                message: 'feed failed',
                                                            },
                                                        };
                                                }, false)
                                            }
                                        >
                                            {t('page.setting.petFeed')}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant={pet.active ? 'ghost' : 'primary'}
                                            disabled={busy || pet.active}
                                            onClick={() => void run(() => petService.setActive(pet.id))}
                                        >
                                            {t('page.setting.petSwitch')}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() =>
                                                confirm({
                                                    titleKey: 'confirm.removePetTitle',
                                                    descKey: 'confirm.removePetDesc',
                                                    descParams: {name: pet.name},
                                                    tone: 'danger',
                                                    onConfirm: () => void run(() => petService.remove(pet.id)),
                                                })
                                            }
                                        >
                                            {t('page.setting.petRemove')}
                                        </Button>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}

                    {importing && (
                        <div
                            className={styles.field}
                            /* 拖文件导入：社区宠物包就是两个文件（pet.json + spritesheet.webp），
                               拖进来比「点按钮 → 文件对话框」顺手；不认识的类型直接忽略 */
                            onDragOver={(event) => {
                                event.preventDefault();
                                setDragging(true);
                            }}
                            onDragLeave={() => setDragging(false)}
                            onDrop={(event) => void dropFiles(event)}
                        >
                            <span className={styles.label}>{t('page.setting.petImportTitle')}</span>
                            <div className={`${styles.petDrop} ${dragging ? styles.petDropActive : ''}`}>
                                {t('page.setting.petDropHint')}
                            </div>
                            <textarea
                                className={styles.textarea}
                                value={specText}
                                placeholder={t('page.setting.petSpecPlaceholder')}
                                onChange={(event) => setSpecText(event.target.value)}
                            />
                            <input
                                type="file"
                                accept=".png,.webp"
                                aria-label={t('page.setting.petAtlasLabel')}
                                onChange={(event) => setAtlasFile(event.currentTarget.files?.[0] ?? null)}
                            />
                            <span className={styles.hint}>
                                {atlasFile
                                    ? t('page.setting.petAtlasPicked', {name: atlasFile.name})
                                    : t('page.setting.petAtlasHint')}
                            </span>
                            <div className={styles.actions}>
                                <Button size="sm" variant="primary" disabled={busy} onClick={() => void importPackage()}>
                                    {busy ? t('common.loading') : t('page.setting.petInstall')}
                                </Button>
                            </div>
                        </div>
                    )}

                    <PetDebugPanel activePetId={pets.find((pet) => pet.active)?.id ?? pets[0]?.id ?? null}/>

                    {notice && <TextCell tone="accent">{notice}</TextCell>}
                    {error && <TextCell tone="danger">{error}</TextCell>}
                </>
            )}
        </>
    );
}

export default PetCard;










