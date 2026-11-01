import {useCallback, useEffect, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {TextCell} from '../../../components/ui/data-table';
import {Button} from '../../../components/ui/button';
import {petService} from '../../../services';
import {windowService} from '../../../services/window.service';
import {
    PET_WINDOW_LABEL,
    PET_WINDOW_POSITION_KEY,
    readPetPosition,
} from '../../../services/window.service';
import styles from '../setting.module.css';

/**
 * 宠物调试面板（开发用）。
 *
 * 为什么单独做一块：宠物的真实状态分散在三个地方——核心库里的资料（好感/饥饿）、
 * 渲染层的帧（动画/帧号/look/walk）、宿主窗口（位置/尺寸/可见），界面上的宠物卡片
 * 只该展示「用户关心的东西」。排查时又必须同时看到这三层，所以给一个显式的调试面板：
 *
 * - **只读**：窗口位置、图集大小、资料、最近一帧；
 * - **能动手**：探测一帧（调一次 `pet.tick`，`dtMs=0`）、喂食、摸一下、重置窗口位置。
 *
 * 注意它**不会**伪造数据：读不到就显示读不到的原因（比如宠物窗口还没起来）。
 */

interface Probe {
    animation: string;
    /** 动画名（按 `pet.state` 里的 spec 反查；查不到就只用序号） */
    animationName: string | null;
    frame: number;
    look: number | null;
    bubble: string | null;
    roundTripMs: number;
}

interface WindowInfo {
    visible: boolean;
    position: string;
    size: string;
    saved: string;
    locked: boolean;
    roam: boolean;
}

interface AtlasInfo {
    file: string;
    kilobytes: number;
}

export function PetDebugPanel({activePetId}: {activePetId: string | null}) {
    const {t} = useTranslation();
    const [open, setOpen] = useState(false);
    const [probe, setProbe] = useState<Probe | null>(null);
    const [windowInfo, setWindowInfo] = useState<WindowInfo | null>(null);
    const [atlas, setAtlas] = useState<AtlasInfo | null>(null);
    const [animationNames, setAnimationNames] = useState<string[]>([]);
    /** 核心版本 + 当前宠物包要求的核心版本（「这个包装得上吗」的答案就在这） */
    const [core, setCore] = useState<{version: string; required: string | null} | null>(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    const readWindow = useCallback(async () => {
        try {
            const {WebviewWindow} = await import('@tauri-apps/api/webviewWindow');
            const win = await WebviewWindow.getByLabel(PET_WINDOW_LABEL);
            if (!win) {
                setWindowInfo(null);
                return;
            }
            const [visible, position, size] = await Promise.all([
                win.isVisible(),
                win.outerPosition(),
                win.outerSize(),
            ]);
            const saved = readPetPosition();
            setWindowInfo({
                visible,
                position: `${position.x}, ${position.y}`,
                size: `${size.width}×${size.height}`,
                saved: saved ? `${saved.x}, ${saved.y}` : t('page.setting.petDebugNone'),
                locked: windowService.petLocked(),
                roam: windowService.petRoam(),
            });
        } catch {
            setWindowInfo(null);
        }
    }, [t]);

    /* 帧里的 `animation` 是序号，看名字才知道是哪个动作：从 `pet.state` 的 spec 反查。
       （没有单独的 `pet.get`，`pet.state` 已经把 spec 带回来了） */
    const readAnimations = useCallback(async () => {
        if (!activePetId) {
            setAnimationNames([]);
            return;
        }
        const result = await petService.state();
        const pet = result.ok ? result.data?.pets.find((item) => item.id === activePetId) : null;
        setAnimationNames(pet ? pet.spec.animations.map((animation) => animation.name) : []);
        setCore(
            result.ok && result.data
                ? {
                    version: result.data.coreVersion,
                    required: pet?.spec.minPetCoreVersion?.trim() || null,
                }
                : null,
        );
    }, [activePetId]);

    const readAtlas = useCallback(async () => {
        if (!activePetId) {
            setAtlas(null);
            return;
        }
        const result = await petService.atlas(activePetId);
        if (!result.ok || !result.data) {
            setAtlas(null);
            return;
        }
        /* base64 长度 × 3/4 ≈ 原始字节数（不用真的解码一遍验证） */
        const bytes = Math.floor((result.data.dataBase64.length * 3) / 4);
        setAtlas({file: result.data.file, kilobytes: Math.round(bytes / 1024)});
    }, [activePetId]);

    /* 读一帧：`dtMs = 0`，只问「现在这一帧长什么样」，不推进动画。 */
    const probeOnce = useCallback(async () => {
        if (!activePetId) return;
        setBusy(true);
        const started = performance.now();
        try {
            const result = await petService.tick({petId: activePetId, dtMs: 0});
            const roundTripMs = Math.round((performance.now() - started) * 10) / 10;
            if (!result.ok || !result.data) {
                setProbe(null);
                setNotice(result.error?.message ?? t('page.setting.petDebugFailed'));
                return;
            }
            setNotice(null);
            const {frame, bubble} = result.data;
            setProbe({
                animation: String(frame.animation),
                animationName: animationNames[frame.animation] ?? null,
                frame: frame.frame,
                look: frame.look ?? null,
                bubble: bubble?.key ?? null,
                roundTripMs,
            });
        } catch (err) {
            /* 抛异常（而不是返回错误信封）时也必须说出来：调试面板最怕「点了没反应」 */
            setProbe(null);
            setNotice(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, [activePetId, animationNames, t]);

    useEffect(() => {
        if (!open) return;
        void readWindow();
        void readAtlas();
        void readAnimations();
        /* 展开就自动读一帧：调试面板的默认状态就该是有数据的，不该等用户再点一下 */
        void probeOnce();
        const timer = window.setInterval(() => void readWindow(), 1000);
        return () => window.clearInterval(timer);
    }, [open, readWindow, readAtlas, readAnimations, probeOnce]);

    const interact = async (kind: 'feed' | 'touch') => {
        if (!activePetId) return;
        const result = await petService.interact(activePetId, kind);
        setNotice(result.ok ? t('page.setting.petDebugOk') : (result.error?.message ?? t('page.setting.petDebugFailed')));
    };

    const resetWindow = async () => {
        try {
            window.localStorage.removeItem(PET_WINDOW_POSITION_KEY);
        } catch {
            /* 存储被禁用：位置本来也记不住 */
        }
        await windowService.hidePetWindow();
        const ok = await windowService.showPetWindow();
        setNotice(ok ? t('page.setting.petDebugOk') : t('page.setting.petDebugFailed'));
        await readWindow();
    };

    return (
        <div className={styles.field}>
            <span className={styles.label}>{t('page.setting.petDebug')}</span>
            <span className={styles.value}>
                <Button size="sm" variant="ghost" onClick={() => setOpen((prev) => !prev)}>
                    {open ? t('page.setting.petImportClose') : t('page.setting.petDebugOpen')}
                </Button>
            </span>
            {open && (
                <div className={styles.petDebug}>
                    <div className={styles.petDebugRow}>
                        <TextCell tone="muted">{t('page.setting.petDebugPet')}</TextCell>
                        <TextCell>{activePetId ?? t('page.setting.petDebugNone')}</TextCell>
                    </div>
                    <div className={styles.petDebugRow}>
                        <TextCell tone="muted">{t('page.setting.petDebugWindow')}</TextCell>
                        <TextCell>
                            {windowInfo
                                ? `${windowInfo.visible ? t('page.setting.petDebugVisible') : t('page.setting.petDebugHidden')} · ${windowInfo.position} · ${windowInfo.size}`
                                : t('page.setting.petDebugNone')}
                        </TextCell>
                    </div>
                    <div className={styles.petDebugRow}>
                        <TextCell tone="muted">{t('page.setting.petDebugSaved')}</TextCell>
                        <TextCell>{windowInfo?.saved ?? t('page.setting.petDebugNone')}</TextCell>
                    </div>
                    <div className={styles.petDebugRow}>
                        <TextCell tone="muted">{t('page.setting.petDebugCore')}</TextCell>
                        <TextCell>
                            {core
                                ? `${core.version} · ${
                                    core.required
                                        ? `${t('page.setting.petDebugRequires')} ${core.required}`
                                        : t('page.setting.petDebugAnyCore')
                                }`
                                : t('page.setting.petDebugNone')}
                        </TextCell>
                    </div>
                    <div className={styles.petDebugRow}>
                        <TextCell tone="muted">{t('page.setting.petDebugSwitches')}</TextCell>
                        <TextCell>
                            {windowInfo
                                ? `${t('page.setting.petLock')}=${windowInfo.locked ? t('page.setting.petDebugOn') : t('page.setting.petDebugOff')} · ${t('page.setting.petRoam')}=${windowInfo.roam ? t('page.setting.petDebugOn') : t('page.setting.petDebugOff')}`
                                : t('page.setting.petDebugNone')}
                        </TextCell>
                    </div>
                    <div className={styles.petDebugRow}>
                        <TextCell tone="muted">{t('page.setting.petDebugAtlas')}</TextCell>
                        <TextCell>
                            {atlas
                                ? `${atlas.file} · ${atlas.kilobytes} KB`
                                : t('page.setting.petDebugNoAtlas')}
                        </TextCell>
                    </div>
                    <div className={styles.petDebugRow}>
                        <TextCell tone="muted">{t('page.setting.petDebugFrame')}</TextCell>
                        <TextCell>
                            {probe
                                ? `animation=${probe.animationName ? `${probe.animationName}(${probe.animation})` : probe.animation} frame=${probe.frame} look=${probe.look ?? '–'} bubble=${probe.bubble ?? '–'} · ${probe.roundTripMs}ms`
                                : t('page.setting.petDebugNoProbe')}
                        </TextCell>
                    </div>
                    <div className={styles.petDebugActions}>
                        <Button size="sm" variant="primary" disabled={busy || !activePetId} onClick={() => void probeOnce()}>
                            {t('page.setting.petDebugProbe')}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={!activePetId} onClick={() => void interact('feed')}>
                            {t('page.setting.petFeed')}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={!activePetId} onClick={() => void interact('touch')}>
                            {t('page.setting.petDebugTouch')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void resetWindow()}>
                            {t('page.setting.petDebugReset')}
                        </Button>
                    </div>
                    <p className={styles.hint}>{t('page.setting.petDebugHint')}</p>
                    {notice && <TextCell tone="muted">{notice}</TextCell>}
                </div>
            )}
        </div>
    );
}









