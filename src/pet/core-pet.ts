import i18n from '../i18n';
import {petService} from '../services/core.pet';
import {
    BUILTIN_PET_ATLAS_FILE,
    BUILTIN_PET_ATLAS_URL,
    BUILTIN_PET_ID,
    BUILTIN_PET_SPEC,
    BUILTIN_PET_VERSION,
} from './builtin';
import {ATLAS_DISPLAY_HEIGHT, frameBox, lookBox, type AtlasPlan} from './frame-layout';
import {decodeAtlas} from './atlas-image';
import {PET_DRAGGING_EVENT, PET_LOOK_EVENT, PET_WALK_EVENT} from '../services/window.service';
import {publishHitAreas, registerHitAreaElement} from './hit-areas';
import type {PetDefinition, PetInstance, PetPlaybackSnapshot} from './types';
import styles from './pet.module.css';

/**
 * 宠物渲染适配器（M2）：**一个渲染器画「当前出战的那只」**。
 *
 * 为什么不是「一个宠物一个组件」：注册表里的宠物是静态定义，而用户随时能切换/卸载宠物包。
 * 把渲染器做成「读 `pet.state` → 取当前出战 → 画」，切换时只需重新注册（`registerCorePet` 返回注销函数），
 * 不必为每个包生成一个 React 组件。
 *
 * 素材：`pet.atlas` 取回 base64 → `atlas-image` 解码（含 MIME 判定与白底去底）→ `frame-layout` 算「画哪一格」。
 * 支持三种图集：网格 sprite sheet（`atlasLayout`）、网格 + look 两行（v2）、单行帧条（老格式）。
 * 没有图集时走程序化渲染：一个圆 + 状态色。
 */

const TICK_MS = 50;
const BOB_PX = 3;
/** 刷新素材的最大重试：`pet.atlas` 失败时退回程序化渲染，不反复打 IPC */
const MAX_ATLAS_ATTEMPTS = 1;

function hash(value: string): number {
    let result = 0x811c9dc5;
    for (let i = 0; i < value.length; i += 1) {
        result ^= value.charCodeAt(i);
        result = Math.imul(result, 0x01000193) >>> 0;
    }
    return result;
}

/** 把图集 base64 变成「可画的偏移表」；解不开或布局不成立时回 `null`（走程序化渲染） */
async function loadAtlas(
    dataBase64: string,
    file: string,
    animations: {name: string; frames: number; row?: number | null; fit?: unknown}[],
    layout: {frameWidth: number; frameHeight: number; columns: number; rows: number} | null,
    lookRows: [number, number] | null,
): Promise<{plan: AtlasPlan; url: string; animations: {name: string; frames: number; row?: number | null; fit?: unknown}[]} | null> {
    /* 解码、MIME 判定、白底去底都在 `atlas-image` 里（渲染器与设置页预览共用一份） */
    const decoded = await decodeAtlas(dataBase64, file, animations, layout, lookRows, ATLAS_DISPLAY_HEIGHT);
    if (!decoded) return null;
    return {plan: decoded.plan, url: decoded.url, animations};
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
            const bubble = document.createElement('div');
            bubble.className = styles.bubble;
            bubble.hidden = true;
            const body = document.createElement('button');
            body.type = 'button';
            body.className = styles.body;
            body.setAttribute('aria-label', i18n.t('pet.name'));
            body.textContent = '◕';
            /* sprite 单独一层：盒子比单帧大（有的行动画被放大），背景必须挂在**格子大小**的层上，
               否则盒子多出来的地方会露出图集里相邻格子的像素（实测：拖动时右侧多出半个身子）。 */
            const sprite = document.createElement('div');
            sprite.className = styles.spriteLayer;
            sprite.hidden = true;
            body.append(sprite);
            root.append(bubble, body);
            container.append(root);

            let disposed = false;
            let timer: number | null = null;
            let clicked = false;
            let pointer: {x: number; y: number} | null = null;
            let bubbleKey = '';
            let snapshot: PetPlaybackSnapshot = context.getPlayback();
            let petId: string | null = null;
            let atlas: Awaited<ReturnType<typeof loadAtlas>> = null;
            /** 指向哪边（0..15，来自宿主轮询的全局光标）；没有 look 表或宿主不支持时是 null */
            let lookDir: number | null = null;
            /** 正在往哪边走（-1 左 / 0 停 / 1 右；宿主走动时发过来） */
            let walkDir: number | null = null;
            /** 事件订阅（注销时一起收） */
            const subscriptions: (() => void)[] = [];
            /** 拖动时演哪个动画（按名字找 `jump`，找不到就用第一个） */
            const DRAG_ANIMATION_NAME = 'jump';
            const DRAG_FRAME_MS = 150;
            let dragAnimation = -1;
            let dragFrame = 0;
            let dragFrameAt = 0;

            const unsubscribe = context.subscribePlayback((next) => {
                snapshot = next;
            });

            /* 精灵本体登记为可交互区域：宿主据此让「不在宠物身上」的地方点击穿透。
               拖动条那一块由宠物窗口自己登记（R102 起支持多块矩形）。 */
            const unregisterHitArea = registerHitAreaElement('sprite', () => body);
            /** 临时气泡（右键喂食这类「界面自己说话」的反馈）：2.5s 后收，核心给的气泡优先 */
            let hintTimer: number | null = null;
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

            /** 当前动画是不是「待机」：按名字认（`idle`），没有就退化成第 0 个动画 */
            const isIdleAnimation = (animation: number): boolean => {
                const name = atlas?.animations[animation]?.name ?? (animation === 0 ? 'idle' : '');
                return name === 'idle';
            };

            const paint = (animation: number, frame: number, flip: boolean, look: number | null) => {
                if (atlas) {
                    /* 「看向你」只在**待机**时生效：奔跑/跳跃/失败是行为驱动的动作，
                       这时换成一张 look 格会像卡住。没有 look 行的包直接跳过。 */
                    /* 每一行可能带自己的显示适配（`fit`）：整行缩放 + 底部对齐，
                       所以每帧都要按「当前动画」重算 background-size / position。 */
                    const box =
                        look !== null && isIdleAnimation(animation)
                            ? (lookBox(atlas.plan, look) ?? frameBox(atlas.plan, animation, frame))
                            : frameBox(atlas.plan, animation, frame);
                    if (box) {
                        body.classList.add(styles.sprite);
                        body.style.width = `${box.width}px`;
                        body.style.height = `${box.height}px`;
                        body.textContent = '';
                        body.append(sprite);
                        sprite.hidden = false;
                        sprite.style.backgroundImage = `url(${atlas.url})`;
                        sprite.style.backgroundSize = box.backgroundSize;
                        sprite.style.backgroundPosition = `-${box.offsetX}px -${box.offsetY}px`;
                        sprite.style.left = `${box.left}px`;
                        sprite.style.top = `${box.top}px`;
                        sprite.style.width = `${box.frameWidth}px`;
                        sprite.style.height = `${box.frameHeight}px`;
                    }
                    /* 每帧重报一次可交互区域（内容没变宿主不会收到重复事件） */
                    publishHitAreas();
                }
                body.dataset.animation = String(animation);
                body.style.transform = `translateY(${frame % 2 === 0 ? -BOB_PX : 0}px) scaleX(${
                    flip ? -1 : 1
                })`;
            };

            const step = async () => {
                if (disposed || !petId) return;
                const result = await petService.tick({
                    petId,
                    dtMs: TICK_MS,
                    playing: snapshot.playing,
                    elapsedMs: Math.round(snapshot.elapsed * 1000),
                    lyricActive: snapshot.lyric !== null,
                    trackHash: hash(snapshot.track?.id ?? ''),
                    pointerX: pointer?.x ?? null,
                    pointerY: pointer?.y ?? null,
                    clicked,
                    lookDir,
                    walkDir,
                });
                clicked = false;
                if (disposed || !result.ok || !result.data) return;
                const {frame, bubble: info} = result.data;
                if (dragging && atlas && dragAnimation >= 0) {
                    /* 被拎在手里：不演核心给的状态动画，改演「四肢张开」那一行——
                       这也是「不用系统拖动」换来的东西：拖动过程中画面还在动。 */
                    const frames = Math.max(1, atlas.animations[dragAnimation]?.frames ?? 1);
                    const now = performance.now();
                    if (now - dragFrameAt >= DRAG_FRAME_MS) {
                        dragFrameAt = now;
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
                    if (nextKey) bubble.textContent = i18n.t(nextKey);
                }
            };

            /** 装内置宠物（首次安装与升级共用一条路径：规格 + 图集一起给核心） */
            const installBuiltin = async () => {
                const builtinAtlas = await loadBuiltinAtlas();
                if (builtinAtlas) await petService.install(BUILTIN_PET_SPEC, builtinAtlas);
                else await petService.install(BUILTIN_PET_SPEC);
            };

            void (async () => {
                /* 1. 确认出战宠物；一只都没有就先装内置的（首次打开开关的正常路径） */
                let state = await petService.state();
                if (disposed) return;
                if (state.ok && state.data && state.data.pets.length === 0) {
                    await installBuiltin();
                    state = await petService.state();
                }
                if (disposed || !state.ok || !state.data) return;

                /* 1b. 内置宠物随应用升级：库里还是旧版本时按新规格重装一次
                      （M3 加动画、M4 换图集都靠它；用户自己导入的包不动）。 */
                const installedBuiltin = state.data.pets.find((pet) => pet.id === BUILTIN_PET_ID);
                if (installedBuiltin && installedBuiltin.version !== BUILTIN_PET_VERSION) {
                    await installBuiltin();
                    state = await petService.state();
                    if (disposed || !state.ok || !state.data) return;
                }

                const active = state.data.pets.find((pet) => pet.active) ?? state.data.pets[0];
                if (!active) return;
                petId = active.id;

                /* 2. 有图集就按布局画；没有（或取不回来）就走程序化渲染 */
                let attempts = 0;
                while (!disposed && attempts <= MAX_ATLAS_ATTEMPTS) {
                    const result = await petService.atlas(active.id);
                    if (!result.ok || !result.data) break;
                    atlas = await loadAtlas(
                        result.data.dataBase64,
                        result.data.file,
                        active.spec.animations,
                        active.spec.atlasLayout ?? null,
                        active.spec.lookRows ?? null,
                    );
                    if (atlas) break;
                    attempts += 1;
                }
                if (atlas) {
                    const found = atlas.animations.findIndex(
                        (animation) => animation.name === DRAG_ANIMATION_NAME,
                    );
                    dragAnimation = found >= 0 ? found : 0;
                }
                if (disposed) return;
                timer = window.setInterval(() => void step(), TICK_MS);
            })();

            /* 「看向你」：宿主轮询全局光标，方向变了才发事件（非 Windows 平台没有这个事件） */
            void (async () => {
                try {
                    const {listen} = await import('@tauri-apps/api/event');
                    const unLook = await listen<number>(PET_LOOK_EVENT, (event) => {
                        if (typeof event.payload === 'number') lookDir = event.payload;
                    });
                    subscriptions.push(unLook);
                    /* 走动：宿主在挪窗口，我们只把方向转给核心去挑 runLeft/runRight */
                    const unWalk = await listen<number>(PET_WALK_EVENT, (event) => {
                        if (typeof event.payload === 'number') walkDir = event.payload === 0 ? null : event.payload;
                    });
                    subscriptions.push(unWalk);
                } catch {
                    /* 浏览器预览没有事件总线：留在「不看」的状态 */
                }
            })();


            const onPointerEnter = (event: PointerEvent) => {
                pointer = {x: Math.round(event.offsetX), y: Math.round(event.offsetY)};
            };
            const onPointerLeave = () => {
                pointer = null;
            };
            /* 拖宠物本体 = **自己搬窗口**（只在独立的宠物窗口里；主窗口里没有意义）。
               为什么不用系统的 `startDragging()`：那会把事件循环交出去——拖的过程中
               既播不了「被拎起来」的动画，手感也像在拖一个看不见的窗口边框（用户原话）。
               现在按「屏幕坐标差」自己算位置：拖动时 JS 一直在跑，动画照样走。 */
            const inPetWindow =
                typeof document !== 'undefined' && document.documentElement.dataset.window === 'pet';
            const DRAG_THRESHOLD = 5;
            /** 按住时的基准：屏幕坐标 + 那一刻的窗口位置（物理像素） */
            let press: {screenX: number; screenY: number; originX: number; originY: number; id: number} | null =
                null;
            let dragging = false;
            let swallowClick = false;
            /** 待应用的窗口位置（rAF 合并：一帧最多挪一次，IPC 不会被打爆） */
            let pendingMove: {x: number; y: number} | null = null;
            let moveFrame: number | null = null;
            /** 窗口 API 句柄（宠物窗口里才有；主窗口/浏览器预览是 null） */
            let windowHandle: {setPosition: (position: {x: number; y: number}) => Promise<void>} | null =
                null;
            const setPetDragging = (next: boolean) => {
                if (dragging === next) return;
                dragging = next;
                body.classList.toggle(styles.dragging, next);
                void import('@tauri-apps/api/event')
                    .then(({emit}) => emit(PET_DRAGGING_EVENT, {dragging: next}))
                    .catch(() => undefined);
            };
            const flushMove = () => {
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
                press = {
                    screenX: event.screenX,
                    screenY: event.screenY,
                    originX: 0,
                    originY: 0,
                    id: event.pointerId,
                };
                /* 先把「按下那一刻窗口在哪」读回来：拖动期间位置由我们自己算，
                   不能用「当前窗口位置 + 增量」（IPC 是异步的，会累积误差） */
                void (async () => {
                    try {
                        const {getCurrentWindow, PhysicalPosition} = await import('@tauri-apps/api/window');
                        const handle = getCurrentWindow();
                        windowHandle = {
                            setPosition: (position: {x: number; y: number}) =>
                                handle.setPosition(
                                    new PhysicalPosition(Math.round(position.x), Math.round(position.y)),
                                ),
                        };
                        const origin = await handle.outerPosition();
                        if (!press) return;
                        press.originX = origin.x;
                        press.originY = origin.y;
                        try {
                            body.setPointerCapture(event.pointerId);
                        } catch {
                            /* 拿不到捕获也能拖（窗口跟着光标走） */
                        }
                    } catch {
                        /* 浏览器预览没有窗口 API：拖动退化成「按着不动」 */
                    }
                })();
            };
            const onPointerMove = (event: PointerEvent) => {
                if (!press || !inPetWindow) return;
                const movedX = event.screenX - press.screenX;
                const movedY = event.screenY - press.screenY;
                if (!dragging) {
                    if (Math.hypot(movedX, movedY) < DRAG_THRESHOLD) return;
                    /* 判定为拖：后面那一次 click 要吞掉（否则「拖一下」会顺手摸一把） */
                    swallowClick = true;
                    setPetDragging(true);
                }
                const ratio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
                queueMove(press.originX + movedX * ratio, press.originY + movedY * ratio);
            };
            const endPress = () => {
                press = null;
                if (moveFrame !== null) {
                    window.cancelAnimationFrame(moveFrame);
                    moveFrame = null;
                }
                pendingMove = null;
                if (dragging) {
                    setPetDragging(false);
                    /* 松手后紧跟的那一次 click 不是「摸」：400ms 内都吞掉 */
                    window.setTimeout(() => {
                        swallowClick = false;
                    }, 400);
                }
            };
            const onPointerUp = () => {
                endPress();
            };
            const onPointerCancel = () => {
                endPress();
            };
            const onClick = (event: MouseEvent) => {
                event.stopPropagation();
                if (swallowClick) {
                    swallowClick = false;
                    return;
                }
                clicked = true;
                if (petId) void petService.interact(petId, 'touch');
            };
            /* 右键 = 喂食（不用开设置页就能喂）。冷却中核心会回错，界面用气泡如实说明，
               而不是「点了没反应」——宠物本体没有按钮可以变灰。 */
            const onContextMenu = (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                if (!petId) return;
                void (async () => {
                    const result = await petService.interact(petId, 'feed');
                    if (disposed) return;
                    showHint(result.ok ? 'pet.bubble.fed' : 'pet.bubble.feedCooldown');
                })();
            };
            /* 窗口失焦（切到别的程序）时补一条「没在拖」：`startDragging` 之后
               pointerup 常常收不到，宿主那边不能一直以为在拖。 */
            const onWindowBlur = () => {
                endPress();
                setPetDragging(false);
            };
            body.addEventListener('pointerenter', onPointerEnter);
            body.addEventListener('pointerleave', onPointerLeave);
            body.addEventListener('pointerdown', onPointerDown);
            body.addEventListener('pointermove', onPointerMove);
            body.addEventListener('pointerup', onPointerUp);
            body.addEventListener('pointercancel', onPointerCancel);
            body.addEventListener('click', onClick);
            body.addEventListener('contextmenu', onContextMenu);
            window.addEventListener('blur', onWindowBlur);

            return {
                dispose: () => {
                    disposed = true;
                    if (timer !== null) window.clearInterval(timer);
                    unsubscribe();
                    for (const un of subscriptions) un();
                    body.removeEventListener('pointerenter', onPointerEnter);
                    body.removeEventListener('pointerleave', onPointerLeave);
                    body.removeEventListener('pointerdown', onPointerDown);
                    body.removeEventListener('pointermove', onPointerMove);
                    body.removeEventListener('pointerup', onPointerUp);
                    body.removeEventListener('pointercancel', onPointerCancel);
                    body.removeEventListener('click', onClick);
                    body.removeEventListener('contextmenu', onContextMenu);
                    window.removeEventListener('blur', onWindowBlur);
                    unregisterHitArea();
                    sprite.style.backgroundImage = '';
                    sprite.remove();
                    body.style.backgroundImage = '';
                    root.remove();
                },
            };
        },
    };
}
















