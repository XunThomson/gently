import i18n from '../i18n';
import {petService, type PetProfileDto, type PetStateDto} from '../services/core.pet';
import {
    BUILTIN_PET_ATLAS_FILE,
    BUILTIN_PET_ATLAS_URL,
    BUILTIN_PET_ID,
    BUILTIN_PET_SPEC,
    BUILTIN_PET_VERSION,
} from './builtin';
import {frameBox, lookBox, planAtlas, type AtlasLayout, type AtlasPlan, type LayoutAnimation} from './frame-layout';
import {decodeAtlas} from './atlas-image';
import {
    PET_DRAGGING_EVENT,
    PET_LOOK_EVENT,
    PET_MENU_EVENT,
    PET_PROFILE_EVENT,
    PET_ROAM_EVENT,
    PET_SIZE_EVENT,
    PET_WALK_EVENT,
    windowService,
} from '../services/window.service';
import {PET_DISPLAY_HEIGHT, parsePetSize, petMonitorRects, type PetSize} from '../utils/petPresentation';
import {
    PET_HUD_GAP,
    PET_HUD_RESERVE,
    layoutPetWindow,
    type PetHudSide,
    type Point,
    type Rect,
} from '../utils/petWindowPosition';
import {BODY_HIT_AREA_ID, publishHitAreas, registerHitAreaElement} from './hit-areas';
import type {PetDefinition, PetInstance, PetPlaybackSnapshot} from './types';
import styles from './pet.module.css';

const TICK_MS = 50;
const MAX_TICK_DT_MS = 250;
const TICK_ERROR_BACKOFF_MS = 500;
const PROFILE_REFRESH_MS = 60_000;
const BOB_PX = 3;
const DRAG_ANIMATION_NAME = 'jump';
const DRAG_FRAME_MS = 150;

interface LoadedAtlas {
    plan: AtlasPlan;
    url: string;
    animations: LayoutAnimation[];
    layout: AtlasLayout | null;
    lookRows: [number, number] | null;
}

type ActivePet = PetStateDto['pets'][number];

function hash(value: string): number {
    let result = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        result ^= value.charCodeAt(i);
        result = Math.imul(result, 0x01000193) >>> 0;
    }
    return result;
}

async function loadAtlas(
    dataBase64: string,
    file: string,
    animations: LayoutAnimation[],
    layout: AtlasLayout | null,
    lookRows: [number, number] | null,
    displayHeight: number,
): Promise<LoadedAtlas | null> {
    const decoded = await decodeAtlas(dataBase64, file, animations, layout, lookRows, displayHeight);
    return decoded ? {plan: decoded.plan, url: decoded.url, animations, layout, lookRows} : null;
}

/** 读内置图集：打包后的静态资源 → base64（失败就退回程序化渲染，不让宠物消失） */
async function loadBuiltinAtlas(): Promise<{file: string; dataBase64: string} | null> {
    try {
        const response = await fetch(BUILTIN_PET_ATLAS_URL);
        if (!response.ok) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        const chunk = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunk) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
        }
        return {file: BUILTIN_PET_ATLAS_FILE, dataBase64: btoa(binary)};
    } catch {
        return null;
    }
}

/**
 * 创建一个「渲染当前出战宠物」的适配器。
 *
 * 首次运行时如果一只宠物都没有，自动安装内置小家伙（否则实验开关打开后是一片空白）。
 */
export function createCorePet(): PetDefinition {
    return {
        id: 'core-pet',
        name: 'Core pet renderer',
        version: '1.0.0',
        mount(container: HTMLElement, context): PetInstance {
            const root = document.createElement('div');
            root.className = styles.builtin;

            const status = document.createElement('section');
            status.className = styles.status;
            status.hidden = true;
            status.setAttribute('aria-label', i18n.t('pet.status.title'));
            const statusHeading = document.createElement('div');
            statusHeading.className = styles.statusHeading;
            const petName = document.createElement('strong');
            const mood = document.createElement('span');
            statusHeading.append(petName, mood);
            const satietyLabel = document.createElement('span');
            satietyLabel.textContent = i18n.t('pet.status.satiety');
            const satiety = document.createElement('progress');
            satiety.className = styles.meter;
            satiety.max = 100;
            const affectionLabel = document.createElement('span');
            affectionLabel.textContent = i18n.t('pet.status.affection');
            const affection = document.createElement('span');
            affection.className = styles.statusValue;
            const statusRow = document.createElement('div');
            statusRow.className = styles.statusRow;
            statusRow.append(satietyLabel, satiety, affectionLabel, affection);
            status.append(statusHeading, statusRow);

            const bubble = document.createElement('div');
            bubble.className = styles.bubble;
            bubble.hidden = true;

            const menu = document.createElement('div');
            menu.className = styles.menu;
            menu.hidden = true;
            menu.setAttribute('role', 'menu');
            const makeMenuButton = (key: string): HTMLButtonElement => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = styles.menuItem;
                button.textContent = i18n.t(key);
                return button;
            };
            const feedButton = makeMenuButton('pet.action.feed');
            const touchButton = makeMenuButton('pet.action.touch');
            const sizeLabel = document.createElement('span');
            sizeLabel.className = styles.menuLabel;
            sizeLabel.textContent = i18n.t('pet.action.size');
            const sizeGroup = document.createElement('div');
            sizeGroup.className = styles.sizeGroup;
            const sizeButtons = (['small', 'medium', 'large'] as const).map((petSize) => {
                const button = makeMenuButton(`pet.size.${petSize}`);
                button.className = styles.sizeButton;
                button.dataset.size = petSize;
                sizeGroup.append(button);
                return button;
            });
            const roamButton = makeMenuButton('pet.action.roamStart');
            const hideButton = makeMenuButton('pet.action.hide');
            menu.append(feedButton, touchButton, sizeLabel, sizeGroup, roamButton, hideButton);

            const hud = document.createElement('div');
            hud.className = styles.hud;
            hud.dataset.side = 'above';
            hud.append(status, bubble, menu);

            const body = document.createElement('button');
            body.type = 'button';
            body.className = styles.body;
            body.setAttribute('aria-label', i18n.t('pet.name'));
            body.textContent = '◕';
            const motion = document.createElement('div');
            motion.className = styles.motionLayer;
            motion.hidden = true;
            const sprite = document.createElement('div');
            sprite.className = styles.spriteLayer;
            motion.append(sprite);
            body.append(motion);
            root.append(hud, body);
            container.append(root);

            let disposed = false;
            let timer: number | null = null;
            let hintTimer: number | null = null;
            let swallowTimer: number | null = null;
            let clicked = false;
            let pointer: {x: number; y: number} | null = null;
            let bubbleKey = '';
            let snapshot: PetPlaybackSnapshot = context.getPlayback();
            let petId: string | null = null;
            let activePet: ActivePet | null = null;
            let atlas: LoadedAtlas | null = null;
            let size = windowService.petSize();
            let roam = windowService.petRoam();
            let menuOpen = false;
            let hovered = false;
            let lookDir: number | null = null;
            let walkDir: number | null = null;
            let dragAnimation = -1;
            let dragFrame = 0;
            let dragFrameAt = 0;
            let lastTickAt: number | null = null;
            let lastProfileRefreshAt = 0;
            let profileBusy = false;
            let lastPoseKey = '';
            let lastBodyKey = '';
            let lastSpriteKey = '';
            let lastAtlasUrl = '';
            let resizeBusy = false;
            let resizeRequested = false;
            const subscriptions: (() => void)[] = [];
            const inPetWindow = document.documentElement.dataset.window === 'pet';
            /* 本体脚底中心与 HUD 槽位在窗口内的位置（CSS 像素）：布局纯函数给出。
               窗口是以本体为中心的对称画布，HUD 可以出现在任意一侧。 */
            let anchorOffset: Point = {x: 0, y: 0};
            let hudSide: PetHudSide = 'above';
            let hudRect: Rect | null = null;

            const updateStatus = () => {
                petName.textContent = activePet?.name ?? i18n.t('pet.name');
                mood.textContent = activePet ? i18n.t(`pet.mood.${activePet.mood}`) : '';
                satiety.value = activePet ? Math.max(0, Math.min(100, 100 - activePet.profile.hunger)) : 0;
                affection.textContent = activePet ? String(Math.round(activePet.profile.affection)) : '0';
                for (const button of sizeButtons) {
                    const selected = button.dataset.size === size;
                    button.classList.toggle(styles.selected, selected);
                    button.setAttribute('aria-pressed', String(selected));
                }
                roamButton.textContent = i18n.t(roam ? 'pet.action.roamStop' : 'pet.action.roamStart');
            };

            const updateOverlays = () => {
                /* 菜单与状态卡同时显示会超出 HUD 预留高度；菜单优先，状态卡让位 */
                status.hidden = !activePet || menuOpen || !hovered;
                publishHitAreas();
            };

            /* 把本体（脚底锚定）和 HUD 槽位摆到窗口坐标里。
               两者都由布局纯函数给出：本体可以贴到屏幕边缘，HUD 槽位永远整块在屏幕里。 */
            const placeBodyAndHud = (bodyWidth: number, bodyHeight: number) => {
                if (!inPetWindow) return;
                const viewWidth = window.innerWidth;
                const viewHeight = window.innerHeight;
                body.style.left = `${Math.round(anchorOffset.x - bodyWidth / 2)}px`;
                body.style.top = `${Math.round(anchorOffset.y - bodyHeight)}px`;
                hud.dataset.side = hudSide;
                if (hudRect) {
                    hud.style.left = `${Math.round(hudRect.x)}px`;
                    hud.style.top = `${Math.round(hudRect.y)}px`;
                    hud.style.width = `${Math.round(hudRect.width)}px`;
                    hud.style.height = `${Math.round(hudRect.height)}px`;
                } else {
                    /* 窗口尺寸还没同步回来：先给一个本体上方的临时槽位，避免 HUD 闪在角落 */
                    const slot = Math.min(PET_HUD_RESERVE, viewWidth, viewHeight);
                    hud.style.left = `${Math.round(
                        Math.max(0, Math.min(anchorOffset.x - slot / 2, viewWidth - slot)),
                    )}px`;
                    hud.style.top = `${Math.round(
                        Math.max(0, Math.min(anchorOffset.y - bodyHeight - PET_HUD_GAP - slot, viewHeight - slot)),
                    )}px`;
                    hud.style.width = `${slot}px`;
                    hud.style.height = `${slot}px`;
                }
            };

            /* 当前本体脚底在**屏幕**上的位置（物理像素）：缩放窗口前先量它，缩放后原地不动 */
            const measureAnchor = async (): Promise<Point | null> => {
                if (!inPetWindow) return null;
                try {
                    const {getCurrentWindow} = await import('@tauri-apps/api/window');
                    const win = getCurrentWindow();
                    const [origin, scale] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
                    return {
                        x: Math.round(origin.x + anchorOffset.x * scale),
                        y: Math.round(origin.y + anchorOffset.y * scale),
                    };
                } catch {
                    return null;
                }
            };

            if (inPetWindow) {
                /* 初始：窗口以本体为中心（真实尺寸由首次 resize 回报） */
                anchorOffset = {x: window.innerWidth / 2, y: window.innerHeight / 2};
                placeBodyAndHud(56, 56);
            }

            const setMenuOpen = (open: boolean) => {
                if (menuOpen === open) return;
                menuOpen = open;
                menu.hidden = !open;
                updateOverlays();
                void import('@tauri-apps/api/event')
                    .then(({emit}) => emit(PET_MENU_EVENT, {open}))
                    .catch(() => undefined);
            };

            const requestWindowResize = () => {
                if (!inPetWindow) return;
                resizeRequested = true;
                if (resizeBusy) return;
                resizeBusy = true;
                void (async () => {
                    while (resizeRequested && !disposed) {
                        resizeRequested = false;
                        const height = PET_DISPLAY_HEIGHT[size];
                        const content = {
                            width: atlas?.plan.width ?? height,
                            height: atlas?.plan.height ?? Math.round(height * 1.08),
                        };
                        /* 缩放围绕脚底锚点：先量当前位置，再让窗口服务按新尺寸重新摆 */
                        const anchor = await measureAnchor();
                        const applied = await windowService.resizePetWindow(content, anchor ?? undefined);
                        if (!applied || disposed) continue;
                        anchorOffset = applied.anchor;
                        hudSide = applied.hud;
                        hudRect = applied.hudRect;
                        placeBodyAndHud(
                            body.offsetWidth || content.width,
                            body.offsetHeight || content.height,
                        );
                        publishHitAreas();
                    }
                    resizeBusy = false;
                })();
            };

            const applySize = (next: PetSize) => {
                if (size === next) return;
                size = next;
                if (atlas) {
                    atlas.plan = planAtlas(
                        {animations: atlas.animations, atlasLayout: atlas.layout, lookRows: atlas.lookRows},
                        atlas.plan.imageWidth,
                        atlas.plan.imageHeight,
                        PET_DISPLAY_HEIGHT[size],
                    ) ?? atlas.plan;
                }
                lastPoseKey = '';
                lastBodyKey = '';
                lastSpriteKey = '';
                updateStatus();
                requestWindowResize();
            };

            const unsubscribe = context.subscribePlayback((next) => {
                snapshot = next;
            });
            const unregisterHitAreas = [
                registerHitAreaElement(BODY_HIT_AREA_ID, () => body),
                registerHitAreaElement('pet-status', () => status),
                registerHitAreaElement('pet-menu', () => menu),
            ];

            const showHint = (key: string) => {
                bubble.hidden = false;
                bubble.textContent = i18n.t(key);
                if (hintTimer !== null) window.clearTimeout(hintTimer);
                hintTimer = window.setTimeout(() => {
                    hintTimer = null;
                    bubble.hidden = bubbleKey === '';
                    bubble.textContent = bubbleKey === '' ? '' : i18n.t(bubbleKey);
                }, 2500);
            };

            const applyInteraction = (result: Awaited<ReturnType<typeof petService.interact>>) => {
                if (!activePet || !result.ok || !result.data) return;
                activePet = {
                    ...activePet,
                    profile: result.data.profile as PetProfileDto,
                    mood: result.data.mood,
                    hungry: result.data.hungry,
                };
                updateStatus();
            };

            const refreshProfile = async () => {
                if (!petId || profileBusy) return;
                profileBusy = true;
                const result = await petService.state();
                profileBusy = false;
                if (disposed || !result.ok || !result.data) return;
                const next = result.data.pets.find((pet) => pet.id === petId);
                if (!next) return;
                activePet = next;
                lastProfileRefreshAt = performance.now();
                updateStatus();
            };

            const isIdleAnimation = (animation: number): boolean =>
                (atlas?.animations[animation]?.name ?? (animation === 0 ? 'idle' : '')) === 'idle';

            const paint = (animation: number, frame: number, flip: boolean, look: number | null) => {
                const poseKey = `${animation}:${frame}:${flip}:${look ?? '-'}`;
                if (atlas) {
                    const box =
                        look !== null && isIdleAnimation(animation)
                            ? (lookBox(atlas.plan, look) ?? frameBox(atlas.plan, animation, frame))
                            : frameBox(atlas.plan, animation, frame);
                    const bodyKey = `${box.width}:${box.height}`;
                    if (bodyKey !== lastBodyKey) {
                        lastBodyKey = bodyKey;
                        body.classList.add(styles.sprite);
                        body.style.width = `${box.width}px`;
                        body.style.height = `${box.height}px`;
                        body.textContent = '';
                        body.append(motion);
                        motion.hidden = false;
                        placeBodyAndHud(box.width, box.height);
                        publishHitAreas();
                    }
                    const spriteKey = [
                        box.left,
                        box.top,
                        box.frameWidth,
                        box.frameHeight,
                        box.backgroundSize,
                        box.offsetX,
                        box.offsetY,
                    ].join(':');
                    if (spriteKey !== lastSpriteKey) {
                        lastSpriteKey = spriteKey;
                        if (lastAtlasUrl !== atlas.url) {
                            lastAtlasUrl = atlas.url;
                            sprite.style.backgroundImage = `url(${atlas.url})`;
                        }
                        sprite.style.backgroundSize = box.backgroundSize;
                        sprite.style.backgroundPosition = `-${box.offsetX}px -${box.offsetY}px`;
                        sprite.style.left = `${box.left}px`;
                        sprite.style.top = `${box.top}px`;
                        sprite.style.width = `${box.frameWidth}px`;
                        sprite.style.height = `${box.frameHeight}px`;
                    }
                    if (poseKey !== lastPoseKey) {
                        motion.style.transform = `translateY(${frame % 2 === 0 ? -BOB_PX : 0}px) scaleX(${flip ? -1 : 1})`;
                    }
                } else if (lastBodyKey !== 'fallback') {
                    lastBodyKey = 'fallback';
                    const fallbackSize = Math.round(PET_DISPLAY_HEIGHT[size] / 2);
                    body.style.width = `${fallbackSize}px`;
                    body.style.height = `${fallbackSize}px`;
                    motion.hidden = true;
                    placeBodyAndHud(fallbackSize, fallbackSize);
                    publishHitAreas();
                }
                if (poseKey !== lastPoseKey) {
                    lastPoseKey = poseKey;
                    body.dataset.animation = String(animation);
                }
            };

            const scheduleTick = (delay: number = TICK_MS) => {
                if (disposed || document.hidden || timer !== null || !petId) return;
                timer = window.setTimeout(() => {
                    timer = null;
                    void runTick();
                }, delay);
            };

            const runTick = async () => {
                if (disposed || document.hidden || !petId) return;
                const now = performance.now();
                const dtMs = lastTickAt === null ? TICK_MS : Math.min(MAX_TICK_DT_MS, Math.max(0, now - lastTickAt));
                lastTickAt = now;
                const didClick = clicked;
                clicked = false;
                const result = await petService.tick({
                    petId,
                    dtMs: Math.round(dtMs),
                    playing: snapshot.playing,
                    elapsedMs: Math.round(snapshot.elapsed * 1000),
                    lyricActive: snapshot.lyric !== null,
                    trackHash: hash(snapshot.track?.id ?? ''),
                    pointerX: pointer?.x ?? null,
                    pointerY: pointer?.y ?? null,
                    clicked: didClick,
                    lookDir,
                    walkDir,
                });
                if (disposed) return;
                if (!result.ok || !result.data) {
                    lastTickAt = null;
                    scheduleTick(TICK_ERROR_BACKOFF_MS);
                    return;
                }
                const {frame, bubble: info} = result.data;
                if (dragging && atlas && dragAnimation >= 0) {
                    const frames = Math.max(1, atlas.animations[dragAnimation]?.frames ?? 1);
                    const frameNow = performance.now();
                    if (frameNow - dragFrameAt >= DRAG_FRAME_MS) {
                        dragFrameAt = frameNow;
                        dragFrame = (dragFrame + 1) % frames;
                    }
                    paint(dragAnimation, dragFrame, false, null);
                } else {
                    dragFrame = 0;
                    dragFrameAt = 0;
                    paint(frame.animation, frame.frame, frame.flip, frame.look ?? null);
                }
                const nextKey = info?.key ?? '';
                if (hintTimer !== null && nextKey !== '') {
                    window.clearTimeout(hintTimer);
                    hintTimer = null;
                }
                if (nextKey !== bubbleKey) {
                    bubbleKey = nextKey;
                    bubble.hidden = nextKey === '';
                    bubble.textContent = nextKey ? i18n.t(nextKey) : '';
                }
                if (now - lastProfileRefreshAt >= PROFILE_REFRESH_MS) void refreshProfile();
                scheduleTick();
            };

            const installBuiltin = async () => {
                const builtinAtlas = await loadBuiltinAtlas();
                if (builtinAtlas) await petService.install(BUILTIN_PET_SPEC, builtinAtlas);
                else await petService.install(BUILTIN_PET_SPEC);
            };

            void (async () => {
                let state = await petService.state();
                if (disposed) return;
                if (state.ok && state.data && state.data.pets.length === 0) {
                    await installBuiltin();
                    state = await petService.state();
                }
                if (disposed || !state.ok || !state.data) return;
                const installedBuiltin = state.data.pets.find((pet) => pet.id === BUILTIN_PET_ID);
                if (installedBuiltin && installedBuiltin.version !== BUILTIN_PET_VERSION) {
                    await installBuiltin();
                    state = await petService.state();
                    if (disposed || !state.ok || !state.data) return;
                }
                const active = state.data.pets.find((pet) => pet.active) ?? state.data.pets[0];
                if (!active) return;
                activePet = active;
                petId = active.id;
                lastProfileRefreshAt = performance.now();
                updateStatus();
                const result = await petService.atlas(active.id);
                if (result.ok && result.data) {
                    atlas = await loadAtlas(
                        result.data.dataBase64,
                        result.data.file,
                        active.spec.animations,
                        active.spec.atlasLayout ?? null,
                        active.spec.lookRows ?? null,
                        PET_DISPLAY_HEIGHT[size],
                    );
                }
                if (disposed) return;
                if (atlas) {
                    const found = atlas.animations.findIndex((animation) => animation.name === DRAG_ANIMATION_NAME);
                    dragAnimation = found >= 0 ? found : 0;
                }
                requestWindowResize();
                scheduleTick(0);
            })();

            void (async () => {
                try {
                    const {listen} = await import('@tauri-apps/api/event');
                    const listeners = await Promise.all([
                        listen<number>(PET_LOOK_EVENT, (event) => {
                            if (typeof event.payload === 'number') lookDir = event.payload;
                        }),
                        listen<number>(PET_WALK_EVENT, (event) => {
                            if (typeof event.payload === 'number') walkDir = event.payload === 0 ? null : event.payload;
                        }),
                        listen<{size: string}>(PET_SIZE_EVENT, (event) => {
                            applySize(parsePetSize(event.payload?.size));
                        }),
                        listen<{enabled: boolean}>(PET_ROAM_EVENT, (event) => {
                            roam = event.payload.enabled;
                            updateStatus();
                        }),
                        listen(PET_PROFILE_EVENT, () => void refreshProfile()),
                    ]);
                    if (disposed) for (const unlisten of listeners) unlisten();
                    else subscriptions.push(...listeners);
                } catch {
                    /* 浏览器预览没有窗口事件总线 */
                }
            })();


            const onPointerEnter = (event: PointerEvent) => {
                pointer = {x: Math.round(event.offsetX), y: Math.round(event.offsetY)};
            };
            const onPointerLeave = () => {
                pointer = null;
            };
            const onRootEnter = () => {
                hovered = true;
                updateOverlays();
            };
            const onRootLeave = () => {
                hovered = false;
                if (!menuOpen) updateOverlays();
            };

            const DRAG_THRESHOLD = 5;
            let press: {
                screenX: number;
                screenY: number;
                origin: {x: number; y: number} | null;
                id: number;
            } | null = null;
            let dragging = false;
            let swallowClick = false;
            let pendingMove: {x: number; y: number} | null = null;
            let moveFrame: number | null = null;
            let windowHandle: {setPosition: (position: {x: number; y: number}) => Promise<void>} | null = null;
            /* 拖动只夹**本体**：窗口保持在屏幕里，本体在窗口内滑动（贴边时 HUD 自动换边/让位） */
            let dragState: {
                monitors: Rect[];
                windowSize: {width: number; height: number};
                bodySize: {width: number; height: number};
                startAnchor: Point;
                scale: number;
            } | null = null;
            /* 松手时记住的脚底锚点（屏幕物理像素） */
            let lastAnchor: Point | null = null;

            const setPetDragging = (next: boolean) => {
                if (dragging === next) return;
                dragging = next;
                body.classList.toggle(styles.dragging, next);
                void import('@tauri-apps/api/event')
                    .then(({emit}) => emit(PET_DRAGGING_EVENT, {dragging: next}))
                    .catch(() => undefined);
            };
            const flushMove = () => {
                if (moveFrame !== null) window.cancelAnimationFrame(moveFrame);
                moveFrame = null;
                const target = pendingMove;
                pendingMove = null;
                if (!target || !windowHandle) return;
                void windowHandle.setPosition(target).catch(() => undefined);
            };
            const queueMove = (x: number, y: number) => {
                pendingMove = {x, y};
                if (moveFrame === null) moveFrame = window.requestAnimationFrame(flushMove);
            };

            const onPointerDown = (event: PointerEvent) => {
                if (!inPetWindow || event.button !== 0) return;
                setMenuOpen(false);
                lastAnchor = null;
                dragState = null;
                press = {screenX: event.screenX, screenY: event.screenY, origin: null, id: event.pointerId};
                try {
                    body.setPointerCapture(event.pointerId);
                } catch {
                    /* 没有捕获时仍可跟随屏幕坐标拖动 */
                }
                void (async () => {
                    try {
                        const {availableMonitors, getCurrentWindow, PhysicalPosition} =
                            await import('@tauri-apps/api/window');
                        const handle = getCurrentWindow();
                        windowHandle = {
                            setPosition: (position) =>
                                handle.setPosition(new PhysicalPosition(Math.round(position.x), Math.round(position.y))),
                        };
                        const [origin, size, scale, monitors] = await Promise.all([
                            handle.outerPosition(),
                            handle.innerSize(),
                            handle.scaleFactor(),
                            availableMonitors(),
                        ]);
                        if (press?.id !== event.pointerId) return;
                        const ratio = scale || 1;
                        const nominal = atlas?.plan ?? {width: body.offsetWidth, height: body.offsetHeight};
                        press.origin = {x: origin.x, y: origin.y};
                        dragState = {
                            monitors: petMonitorRects(monitors),
                            windowSize: size,
                            bodySize: {
                                width: Math.round(nominal.width * ratio),
                                height: Math.round(nominal.height * ratio),
                            },
                            startAnchor: {
                                x: origin.x + anchorOffset.x * ratio,
                                y: origin.y + anchorOffset.y * ratio,
                            },
                            scale: ratio,
                        };
                    } catch {
                        /* 浏览器预览没有原生窗口 */
                    }
                })();
            };
            const onPointerMove = (event: PointerEvent) => {
                if (!press?.origin || !inPetWindow) return;
                const movedX = event.screenX - press.screenX;
                const movedY = event.screenY - press.screenY;
                if (!dragging) {
                    if (Math.hypot(movedX, movedY) < DRAG_THRESHOLD) return;
                    swallowClick = true;
                    setPetDragging(true);
                }
                if (!dragState) return;
                const desired = {
                    x: dragState.startAnchor.x + movedX * dragState.scale,
                    y: dragState.startAnchor.y + movedY * dragState.scale,
                };
                const hud = {
                    width: Math.round(PET_HUD_RESERVE * dragState.scale),
                    height: Math.round(PET_HUD_RESERVE * dragState.scale),
                    gap: Math.round(PET_HUD_GAP * dragState.scale),
                };
                const layout = layoutPetWindow(
                    desired,
                    dragState.bodySize,
                    hud,
                    dragState.windowSize,
                    dragState.monitors,
                );
                lastAnchor = {
                    x: layout.window.x + layout.anchor.x,
                    y: layout.window.y + layout.anchor.y,
                };
                anchorOffset = {
                    x: layout.anchor.x / dragState.scale,
                    y: layout.anchor.y / dragState.scale,
                };
                hudSide = layout.hud;
                hudRect = {
                    x: layout.hudRect.x / dragState.scale,
                    y: layout.hudRect.y / dragState.scale,
                    width: layout.hudRect.width / dragState.scale,
                    height: layout.hudRect.height / dragState.scale,
                };
                placeBodyAndHud(
                    body.offsetWidth || dragState.bodySize.width / dragState.scale,
                    body.offsetHeight || dragState.bodySize.height / dragState.scale,
                );
                queueMove(layout.window.x, layout.window.y);
            };
            const endPress = () => {
                flushMove();
                press = null;
                dragState = null;
                if (dragging) {
                    setPetDragging(false);
                    if (lastAnchor) windowService.rememberPetAnchor(lastAnchor);
                    publishHitAreas();
                    if (swallowTimer !== null) window.clearTimeout(swallowTimer);
                    swallowTimer = window.setTimeout(() => {
                        swallowTimer = null;
                        swallowClick = false;
                    }, 400);
                }
            };
            const interact = async (kind: 'feed' | 'touch') => {
                if (!petId) return;
                const result = await petService.interact(petId, kind);
                if (disposed) return;
                applyInteraction(result);
                if (result.ok) windowService.notifyPetProfileChanged();
                if (kind === 'feed') showHint(result.ok ? 'pet.bubble.fed' : 'pet.bubble.feedCooldown');
            };
            const onClick = (event: MouseEvent) => {
                event.stopPropagation();
                if (swallowClick) {
                    swallowClick = false;
                    return;
                }
                clicked = true;
                void interact('touch');
            };
            const onContextMenu = (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                setMenuOpen(!menuOpen);
            };
            const onWindowBlur = () => {
                endPress();
                setPetDragging(false);
                setMenuOpen(false);
            };
            /* 窗口尺寸变了（切档位 / DPI 变化）：HUD 的宽度与底边距离都跟着视口变，重新摆一次 */
            const onWindowResize = () => {
                if (!inPetWindow) return;
                placeBodyAndHud(body.offsetWidth || 56, body.offsetHeight || 56);
                publishHitAreas();
            };
            const onVisibilityChange = () => {
                lastTickAt = null;
                if (document.hidden) {
                    if (timer !== null) window.clearTimeout(timer);
                    timer = null;
                } else {
                    scheduleTick(0);
                }
            };
            const onDocumentPointerDown = (event: PointerEvent) => {
                const target = event.target;
                if (target instanceof Node && !menu.contains(target) && !body.contains(target)) setMenuOpen(false);
            };

            feedButton.addEventListener('click', () => {
                setMenuOpen(false);
                void interact('feed');
            });
            touchButton.addEventListener('click', () => {
                setMenuOpen(false);
                clicked = true;
                void interact('touch');
            });
            for (const button of sizeButtons) {
                button.addEventListener('click', () => {
                    const next = parsePetSize(button.dataset.size);
                    windowService.setPetSize(next);
                    applySize(next);
                });
            }
            roamButton.addEventListener('click', () => {
                roam = !roam;
                windowService.setPetRoam(roam);
                updateStatus();
            });
            hideButton.addEventListener('click', () => {
                setMenuOpen(false);
                /* 隐藏前按脚底锚点记一次：从设置页关掉宠物时也用它回到原处 */
                void (async () => {
                    const anchor = await measureAnchor();
                    if (anchor) windowService.rememberPetAnchor(anchor);
                    await windowService.hidePetWindow();
                    windowService.notifyPetWindowClosed();
                })();
            });
            root.addEventListener('pointerenter', onRootEnter);
            root.addEventListener('pointerleave', onRootLeave);
            body.addEventListener('pointerenter', onPointerEnter);
            body.addEventListener('pointerleave', onPointerLeave);
            body.addEventListener('pointerdown', onPointerDown);
            body.addEventListener('pointermove', onPointerMove);
            body.addEventListener('pointerup', endPress);
            body.addEventListener('pointercancel', endPress);
            body.addEventListener('click', onClick);
            body.addEventListener('contextmenu', onContextMenu);
            document.addEventListener('pointerdown', onDocumentPointerDown);
            document.addEventListener('visibilitychange', onVisibilityChange);
            window.addEventListener('blur', onWindowBlur);
            window.addEventListener('resize', onWindowResize);
            updateStatus();

            return {
                dispose: () => {
                    disposed = true;
                    if (timer !== null) window.clearTimeout(timer);
                    if (hintTimer !== null) window.clearTimeout(hintTimer);
                    if (swallowTimer !== null) window.clearTimeout(swallowTimer);
                    if (moveFrame !== null) window.cancelAnimationFrame(moveFrame);
                    if (menuOpen) {
                        void import('@tauri-apps/api/event')
                            .then(({emit}) => emit(PET_MENU_EVENT, {open: false}))
                            .catch(() => undefined);
                    }
                    if (dragging) {
                        void import('@tauri-apps/api/event')
                            .then(({emit}) => emit(PET_DRAGGING_EVENT, {dragging: false}))
                            .catch(() => undefined);
                    }
                    unsubscribe();
                    for (const unlisten of subscriptions) unlisten();
                    root.removeEventListener('pointerenter', onRootEnter);
                    root.removeEventListener('pointerleave', onRootLeave);
                    body.removeEventListener('pointerenter', onPointerEnter);
                    body.removeEventListener('pointerleave', onPointerLeave);
                    body.removeEventListener('pointerdown', onPointerDown);
                    body.removeEventListener('pointermove', onPointerMove);
                    body.removeEventListener('pointerup', endPress);
                    body.removeEventListener('pointercancel', endPress);
                    body.removeEventListener('click', onClick);
                    body.removeEventListener('contextmenu', onContextMenu);
                    document.removeEventListener('pointerdown', onDocumentPointerDown);
                    document.removeEventListener('visibilitychange', onVisibilityChange);
                    window.removeEventListener('blur', onWindowBlur);
                    window.removeEventListener('resize', onWindowResize);
                    for (const unregister of unregisterHitAreas) unregister();
                    sprite.style.backgroundImage = '';
                    root.remove();
                },
            };
        },
    };
}
















