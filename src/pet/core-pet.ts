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
import {decodeAtlas, type DecodedAtlas} from './atlas-image';
import {
    animationOpaqueRect,
    bodyHitRect,
    lookOpaqueRect,
    unionRect,
    type AlphaBounds,
    type PixelRect,
} from './alpha-bounds';
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
import {
    PET_SIZE_MAX,
    PET_SIZE_MIN,
    clampPetSize,
    parsePetSize,
    petMonitorRects,
    type PetSize,
} from '../utils/petPresentation';
import {
    PET_HUD_GAP,
    PET_HUD_RESERVE,
    bubbleTailOffset,
    layoutPetWindow,
    type PetHudSide,
    type Point,
    type Rect,
} from '../utils/petWindowPosition';
import {
    BODY_HIT_AREA_ID,
    elementRect,
    publishHitAreas,
    registerHitArea,
    registerHitAreaElement,
    type HitArea,
} from './hit-areas';
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
    /** 逐帧不透明包围盒（命中判定只认角色真正占的像素，不认整个格子） */
    alpha: AlphaBounds;
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
    const decoded: DecodedAtlas | null = await decodeAtlas(
        dataBase64,
        file,
        animations,
        layout,
        lookRows,
        displayHeight,
    );
    return decoded
        ? {
              plan: decoded.plan,
              url: decoded.url,
              animations,
              layout,
              lookRows,
              alpha: decoded.alpha,
          }
        : null;
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

/* ---------------- 贴本体浮层的状态与信息架构（纯数据，冒烟直接断言） ---------------- */

/**
 * 宠物窗口里「贴着本体」的浮层：**单值**，所以快捷卡片与完整控制面板天然互斥。
 *
 * 右键本体 → 卡片；点卡片里的「控制面板」→ 面板；点外面 / Esc / 再右键一次 → 关闭。
 */
export type PetSurface = 'none' | 'card' | 'panel';

export type PetSurfaceAction =
    /** 右键本体：没开就开卡片，已经开着就收起（与旧菜单「再右键一次收起」一致） */
    | 'contextmenu'
    /** 卡片里的「控制面板」：切到完整面板（不是新窗口 / 新路由） */
    | 'openPanel'
    /** 点击浮层外 / Esc / 窗口失焦 */
    | 'dismiss';

/** 浮层状态机（纯函数）：返回值只有一个，卡片与面板不可能同时显示 */
export function nextPetSurface(surface: PetSurface, action: PetSurfaceAction): PetSurface {
    switch (action) {
        case 'contextmenu':
            return surface === 'none' ? 'card' : 'none';
        case 'openPanel':
            return 'panel';
        case 'dismiss':
            return 'none';
    }
}

/** 只要有浮层开着，宿主就得整窗接收光标（按钮才点得到）并暂停自动走动 */
export function isPetSurfaceOpen(surface: PetSurface): boolean {
    return surface !== 'none';
}

/** 卡片的快捷操作（顺序即渲染顺序）：只放最高频的两件事，其余进控制面板 */
export const PET_CARD_ACTIONS = ['feed', 'touch'] as const;
export type PetCardAction = (typeof PET_CARD_ACTIONS)[number];

/** 控制面板分区（顺序即渲染顺序）：后续功能往对应分区里加，不用重排布局 */
export const PET_PANEL_SECTIONS = ['quick', 'appearance', 'behavior'] as const;
export type PetPanelSection = (typeof PET_PANEL_SECTIONS)[number];

/** 外观分区里的大小控件：只有滑杆 + 数字输入（三档预设按钮已移除，同一件事不再有两套控件） */
export const PET_SIZE_CONTROLS = ['slider', 'number'] as const;
export type PetSizeControl = (typeof PET_SIZE_CONTROLS)[number];

/**
 * 控制面板分区标题的文案键。
 *
 * 写成显式映射而不是模板字符串：i18n 死键守卫按字面量检索源文件，
 * `pet.panel.${id}` 会被误判成没人使用的键（与设置页尺寸标签同样的处理）。
 */
const PET_SECTION_KEYS: Record<PetPanelSection, string> = {
    quick: 'pet.panel.quick',
    appearance: 'pet.panel.appearance',
    behavior: 'pet.panel.behavior',
};

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
            /* 输入设备模态：只有键盘导航过才画焦点环（宠物窗口里点一下本体不该留白方框） */
            root.dataset.modality = 'pointer';

            const status = document.createElement('section');
            status.className = styles.status;
            status.hidden = true;
            status.setAttribute('aria-label', i18n.t('pet.status.title'));
            const statusHeading = document.createElement('div');
            statusHeading.className = styles.statusHeading;
            const petName = document.createElement('strong');
            const mood = document.createElement('span');
            const level = document.createElement('span');
            level.className = styles.statusValue;
            statusHeading.append(petName, mood, level);
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
            bubble.dataset.visible = 'false';
            bubble.dataset.side = 'above';
            bubble.setAttribute('role', 'status');
            bubble.setAttribute('aria-live', 'polite');
            /* 气泡自己一层（绝对定位），锚在 HUD 槽位贴着本体的那条边上；
               不参与状态卡 / 卡片 / 面板的列布局，所以它们显隐都不会改变气泡到本体的距离。 */
            const bubbleLayer = document.createElement('div');
            bubbleLayer.className = styles.bubbleLayer;
            bubbleLayer.dataset.side = 'above';
            bubbleLayer.append(bubble);

            /* ---------- 贴本体的两层浮层：快捷卡片（右键）与完整控制面板 ----------
               两层**互斥**（`surface` 单值状态）：卡片只放最常用的两件事 + 一个进面板的入口，
               其余功能全部收进控制面板，不再一上来就甩一个六行大菜单。两者都是
               `role="dialog"`：Esc 关闭、行是原生 button、键盘焦点可见。 */
            const makeDialogHeader = () => {
                const header = document.createElement('div');
                header.className = styles.dialogHeader;
                const name = document.createElement('strong');
                name.className = styles.dialogName;
                const meta = document.createElement('span');
                meta.className = styles.dialogMeta;
                header.append(name, meta);
                return {header, name, meta};
            };
            const makeRow = (key: string, className?: string): HTMLButtonElement => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = className ? `${styles.row} ${className}` : styles.row;
                button.textContent = i18n.t(key);
                return button;
            };
            /** 面板分区：小标题 + 行列表（标题键由 `PET_SECTION_KEYS` 给，保证 i18n 可检索） */
            const makeSection = (title: string) => {
                const section = document.createElement('div');
                section.className = styles.section;
                const heading = document.createElement('h3');
                heading.className = styles.sectionTitle;
                heading.textContent = title;
                const rows = document.createElement('div');
                rows.className = styles.rowList;
                section.append(heading, rows);
                return {section, rows};
            };

            /* 卡片：名字 + 心情/等级 → 喂食 / 摸摸 → 控制面板入口 */
            const card = document.createElement('section');
            card.className = `${styles.dialog} ${styles.card}`;
            card.hidden = true;
            card.tabIndex = -1;
            card.setAttribute('role', 'dialog');
            card.setAttribute('aria-label', i18n.t('pet.card.title'));
            const cardIdentity = makeDialogHeader();
            const cardFeed = makeRow('pet.action.feed');
            const cardTouch = makeRow('pet.action.touch');
            const cardButtons: Record<PetCardAction, HTMLButtonElement> = {feed: cardFeed, touch: cardTouch};
            const cardQuick = document.createElement('div');
            cardQuick.className = styles.rowList;
            cardQuick.append(...PET_CARD_ACTIONS.map((action) => cardButtons[action]));
            const panelEntry = makeRow('pet.panel.open', styles.entry);
            card.append(cardIdentity.header, cardQuick, panelEntry);

            /* 控制面板：同一套数据，分区更全（快捷 / 外观 / 行为） */
            const panel = document.createElement('section');
            panel.className = `${styles.dialog} ${styles.panel}`;
            panel.hidden = true;
            panel.tabIndex = -1;
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-label', i18n.t('pet.panel.title'));
            const panelIdentity = makeDialogHeader();
            const panelFeed = makeRow('pet.action.feed');
            const panelTouch = makeRow('pet.action.touch');

            /* 大小：滑杆 + 数字框是**唯一**一套尺寸控件（三档预设按钮已删除，
               同一件事不再有两种入口）。拖动实时应用、松手持久化；数字框回车 / 失焦提交。
               当前像素值直接显示在标题行右侧，用户不用猜滑杆对应多大。 */
            const sizeLabel = document.createElement('span');
            sizeLabel.className = styles.fieldLabel;
            sizeLabel.textContent = i18n.t('pet.action.size');
            const sizeValue = document.createElement('span');
            sizeValue.className = styles.fieldValue;
            const sizeHead = document.createElement('div');
            sizeHead.className = styles.fieldHead;
            sizeHead.append(sizeLabel, sizeValue);
            const sizeSlider = document.createElement('input');
            sizeSlider.type = 'range';
            sizeSlider.className = styles.sizeSlider;
            sizeSlider.min = String(PET_SIZE_MIN);
            sizeSlider.max = String(PET_SIZE_MAX);
            sizeSlider.step = '1';
            sizeSlider.setAttribute('aria-label', i18n.t('pet.action.size'));
            const sizeNumber = document.createElement('input');
            sizeNumber.type = 'number';
            sizeNumber.className = styles.sizeInput;
            sizeNumber.min = String(PET_SIZE_MIN);
            sizeNumber.max = String(PET_SIZE_MAX);
            sizeNumber.step = '1';
            sizeNumber.setAttribute('aria-label', i18n.t('page.setting.petSizeExact'));
            const sizeControlEls: Record<PetSizeControl, HTMLInputElement> = {
                slider: sizeSlider,
                number: sizeNumber,
            };
            const sizeControls = document.createElement('div');
            sizeControls.className = styles.sizeControls;
            sizeControls.append(...PET_SIZE_CONTROLS.map((control) => sizeControlEls[control]));
            const sizeField = document.createElement('div');
            sizeField.className = styles.field;
            sizeField.append(sizeHead, sizeControls);

            /* 走动开关：文字沿用「开始 / 停止游走」，右侧是纯视觉开关（aria-pressed 表达状态）。
               文字用独立 span，`updateStatus` 只改文案，不会把开关节点一起覆盖掉。 */
            const roamLabel = document.createElement('span');
            roamLabel.className = styles.rowLabel;
            roamLabel.textContent = i18n.t('pet.action.roamStart');
            const roamSwitch = document.createElement('span');
            roamSwitch.className = styles.switch;
            roamSwitch.setAttribute('aria-hidden', 'true');
            const roamButton = document.createElement('button');
            roamButton.type = 'button';
            roamButton.className = styles.row;
            roamButton.setAttribute('aria-pressed', 'false');
            roamButton.append(roamLabel, roamSwitch);
            const hideButton = makeRow('pet.action.hide');

            panel.append(panelIdentity.header);
            const panelRows = new Map<PetPanelSection, HTMLElement>();
            for (const sectionId of PET_PANEL_SECTIONS) {
                const {section, rows} = makeSection(i18n.t(PET_SECTION_KEYS[sectionId]));
                panelRows.set(sectionId, rows);
                panel.append(section);
            }
            panelRows.get('quick')?.append(panelFeed, panelTouch);
            panelRows.get('appearance')?.append(sizeField);
            panelRows.get('behavior')?.append(roamButton, hideButton);

            const hud = document.createElement('div');
            hud.className = styles.hud;
            hud.dataset.side = 'above';
            hud.append(status, card, panel, bubbleLayer);

            const body = document.createElement('button');
            body.type = 'button';
            body.className = styles.body;
            /* 本体形态：pending（还没读到图集）/ sprite（有图集）/ fallback（确认没有）。
               底色、圆角、阴影只挂在 fallback 上——精灵形态不可能漏出紫色底。 */
            body.dataset.kind = 'pending';
            body.setAttribute('aria-label', i18n.t('pet.name'));
            body.textContent = '◕';
            /* 启动时先藏起来：状态与图集是异步读的，先显示兜底圆形会让用户看到
               「默认宠物闪一下再切成自己的宠物」（R141 反馈）。第一次真正画出
               图集（或确认没有图集、退回程序化本体）时才显示。 */
            body.style.visibility = 'hidden';
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
            /** 临时提示（喂食冷卻等）优先于核心气泡；2.5s 后自动回落 */
            let bubbleHintKey = '';
            let snapshot: PetPlaybackSnapshot = context.getPlayback();
            let petId: string | null = null;
            let activePet: ActivePet | null = null;
            let atlas: LoadedAtlas | null = null;
            let size = windowService.petSize();
            let roam = windowService.petRoam();
            /** 贴着本体的浮层：none / 卡片 / 控制面板（单值 ⇒ 两者互斥） */
            let surface: PetSurface = 'none';
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
            /* 命中判定跟着**当前显示的那一帧**走：动画/朝向变了才重报矩形 */
            let currentAnimation = 0;
            let currentLook: number | null = null;
            /** 上一次上报命中矩形时的 `动画:朝向`（只有它变了才重报） */
            let lastHitKey = '';
            let bodyKind: 'pending' | 'sprite' | 'fallback' = 'pending';

            /* 本体形态：只在两处切换（读到图集 / 确认没有图集）。
               底色/圆角/阴影/焦点环全部由 CSS 按 `[data-kind]` 决定，
               不再靠「先加类再覆盖」的级联赌注。 */
            const setBodyKind = (kind: 'pending' | 'sprite' | 'fallback') => {
                if (bodyKind === kind) return;
                bodyKind = kind;
                body.dataset.kind = kind;
            };

            /* 气泡尾巴指向本体中心：气泡锚在槽位内边，槽位被屏幕夹过之后会偏，
               所以每次内容/布局变化都重新量一次（只写两个 CSS 变量，不参与布局）。 */
            const placeBubbleTail = () => {
                if (!inPetWindow) return;
                bubble.dataset.side = hudSide;
                bubbleLayer.dataset.side = hudSide;
                const bodyRect = body.getBoundingClientRect();
                const bubbleRect = bubble.getBoundingClientRect();
                if (!(bubbleRect.width > 0) || !(bubbleRect.height > 0)) return;
                const tail = bubbleTailOffset(bodyRect, bubbleRect);
                bubble.style.setProperty('--pet-tail-x', `${tail.x}px`);
                bubble.style.setProperty('--pet-tail-y', `${tail.y}px`);
            };

            /** 当前该说的那句话（临时提示优先于核心文案） */
            const bubbleText = (): string => {
                const key = bubbleHintKey !== '' ? bubbleHintKey : bubbleKey;
                return key === '' ? '' : i18n.t(key);
            };

            /* 气泡唯一的状态写入口：文案 + 显隐。显隐优先级由 `updateOverlays` 统一裁决。 */
            const applyBubble = () => {
                const text = bubbleText();
                if (bubble.textContent !== text) bubble.textContent = text;
                const visible = text !== '' && surface === 'none';
                bubble.dataset.visible = String(visible);
                if (visible) placeBubbleTail();
            };

            /** 卡片 / 面板头部的名字与「心情 · 等级」（没读到宠物数据时只显示名字） */
            const identity = (): {name: string; meta: string} => {
                if (!activePet) return {name: i18n.t('pet.name'), meta: ''};
                return {
                    name: activePet.name,
                    meta: [
                        i18n.t(`pet.mood.${activePet.mood}`),
                        i18n.t('pet.status.level', {level: activePet.growth?.level ?? 1}),
                    ]
                        .filter(Boolean)
                        .join(' · '),
                };
            };

            const updateStatus = () => {
                const who = identity();
                for (const header of [cardIdentity, panelIdentity]) {
                    if (header.name.textContent !== who.name) header.name.textContent = who.name;
                    if (header.meta.textContent !== who.meta) header.meta.textContent = who.meta;
                }
                petName.textContent = who.name;
                mood.textContent = activePet ? i18n.t(`pet.mood.${activePet.mood}`) : '';
                /* 养成反馈（R139）：等级 + 连续到访天数。放在悬停状态卡里，不抢主界面。 */
                level.textContent = activePet
                    ? [
                          i18n.t('pet.status.level', {
                              level: activePet.growth?.level ?? 1,
                          }),
                          (activePet.growth?.streakDays ?? 0) > 0
                              ? i18n.t('pet.status.streak', {
                                    days: activePet.growth?.streakDays ?? 0,
                                })
                              : '',
                      ]
                          .filter(Boolean)
                          .join(' · ')
                    : '';
                satiety.value = activePet ? Math.max(0, Math.min(100, 100 - activePet.profile.hunger)) : 0;
                affection.textContent = activePet ? String(Math.round(activePet.profile.affection)) : '0';
                /* 尺寸的唯一显示入口：滑杆 / 数字框 / 标题行右侧的像素值同源 */
                sizeValue.textContent = i18n.t('page.setting.petSizeUnit', {value: size});
                sizeSlider.value = String(size);
                if (document.activeElement !== sizeNumber) sizeNumber.value = String(size);
                roamLabel.textContent = i18n.t(roam ? 'pet.action.roamStop' : 'pet.action.roamStart');
                roamButton.setAttribute('aria-pressed', String(roam));
            };

            const updateOverlays = () => {
                /* 状态卡 / 卡片 / 面板 / 气泡共用「贴着本体」的那条边，同时只显示一个：
                   浮层 > 气泡 > 悬停状态卡。互相不推挤，气泡到本体的距离恒定。 */
                const speech = bubbleText() !== '';
                status.hidden = !activePet || surface !== 'none' || !hovered || speech;
                applyBubble();
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
                /* HUD 槽位/本体位置一变，气泡尾巴的指向也要跟着量 */
                placeBubbleTail();
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

                /* 位置持续落盘（R144）：以前只在「拖完 / 点隐藏」时记锚点，
                   走动（`pet_watch` 直接搬窗口）之后并不更新；页面一旦被重载，
                   宠物会跳回上一次拖拽的位置。这里监听窗口移动，停稳 400ms 后
                   把**当前脚底锚点**写进 localStorage（两个窗口同源共享）。 */
                void (async () => {
                    try {
                        const {getCurrentWindow} = await import('@tauri-apps/api/window');
                        const win = getCurrentWindow();
                        let saveTimer: number | null = null;
                        const saveAnchor = () => {
                            if (saveTimer !== null) window.clearTimeout(saveTimer);
                            saveTimer = window.setTimeout(() => {
                                saveTimer = null;
                                void (async () => {
                                    const anchor = await measureAnchor();
                                    if (!disposed && anchor) windowService.rememberPetAnchor(anchor);
                                })();
                            }, 400);
                        };
                        const unlisten = await win.onMoved(saveAnchor);
                        if (disposed) unlisten();
                        else subscriptions.push(unlisten);
                    } catch {
                        /* 窗口 API 不可用（测试 / 浏览器）：位置仍按旧路径在拖拽结束时落盘 */
                    }
                })();
            }

            /* 浮层唯一的状态写入口：单值 `surface` 保证卡片与面板互斥。
               只要不是 none，就告诉宿主「窗口正在被操作」——整窗接收光标、暂停走动
               （`PET_MENU_EVENT` 的语义与旧右键菜单完全一致，Rust 侧无需改动）；
               卡片 ↔ 面板互切时开合状态没变，不重复发事件。 */
            const setSurface = (next: PetSurface, restoreFocus = true) => {
                if (surface === next) return;
                const wasOpen = isPetSurfaceOpen(surface);
                surface = next;
                card.hidden = surface !== 'card';
                panel.hidden = surface !== 'panel';
                if (surface === 'none') {
                    const active = document.activeElement;
                    if (restoreFocus && active instanceof Node && (card.contains(active) || panel.contains(active))) {
                        body.focus({preventScroll: true});
                    }
                } else {
                    (surface === 'card' ? card : panel).focus({preventScroll: true});
                }
                updateOverlays();
                const open = isPetSurfaceOpen(surface);
                if (open === wasOpen) return;
                void import('@tauri-apps/api/event')
                    .then(({emit}) => emit(PET_MENU_EVENT, {open}))
                    .catch(() => undefined);
            };

            const dismissSurface = () => setSurface('none');

            const requestWindowResize = () => {
                if (!inPetWindow) return;
                resizeRequested = true;
                if (resizeBusy) return;
                resizeBusy = true;
                void (async () => {
                    while (resizeRequested && !disposed) {
                        resizeRequested = false;
                        const height = size;
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
                const clamped = clampPetSize(next);
                if (size === clamped) return;
                size = clamped;
                if (atlas) {
                    atlas.plan = planAtlas(
                        {animations: atlas.animations, atlasLayout: atlas.layout, lookRows: atlas.lookRows},
                        atlas.plan.imageWidth,
                        atlas.plan.imageHeight,
                        size,
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

            const showHint = (key: string) => {
                bubbleHintKey = key;
                updateOverlays();
                if (hintTimer !== null) window.clearTimeout(hintTimer);
                hintTimer = window.setTimeout(() => {
                    hintTimer = null;
                    bubbleHintKey = '';
                    updateOverlays();
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
                    /* 图集已就绪：本体立刻切成 sprite 形态（透明、无外框），
                       绝不能等到「尺寸 key 变了」才切（旧版就是靠那一步加类，漏一次就露紫底）。 */
                    setBodyKind('sprite');
                    const box =
                        look !== null && isIdleAnimation(animation)
                            ? (lookBox(atlas.plan, look) ?? frameBox(atlas.plan, animation, frame))
                            : frameBox(atlas.plan, animation, frame);
                    const bodyKey = `${box.width}:${box.height}`;
                    if (bodyKey !== lastBodyKey) {
                        lastBodyKey = bodyKey;
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
                    setBodyKind('fallback');
                    const fallbackSize = Math.round(size / 2);
                    body.style.width = `${fallbackSize}px`;
                    body.style.height = `${fallbackSize}px`;
                    motion.hidden = true;
                    placeBodyAndHud(fallbackSize, fallbackSize);
                    publishHitAreas();
                }
                if (poseKey !== lastPoseKey) {
                    lastPoseKey = poseKey;
                    body.dataset.animation = String(animation);
                    /* 命中矩形按**当前动画（含 look 朝向）**的不透明像素算：换动画/换朝向才重报，
                       不跟着每一帧抖动（宿主 60ms 轮询一次，没必要每帧换热区） */
                    const hitKey = `${animation}:${look ?? '-'}`;
                    if (hitKey !== lastHitKey) {
                        lastHitKey = hitKey;
                        currentAnimation = animation;
                        currentLook = look;
                        publishHitAreas();
                    }
                }
                /* 第一帧就绪后再显示：宁可晚几十毫秒出现，也不要先闪一个默认宠物 */
                if (body.style.visibility === 'hidden') body.style.visibility = 'visible';
            };

            /**
             * 本体自己的命中矩形（窗口坐标，CSS 像素）。
             *
             * 取「当前动画所有帧的不透明像素并集」而不是元素盒子：盒子是图集格子，
             * 角色只占其中一部分（上面还有一圈透明留白 + 像素画的空角），
             * 用盒子判定会出现「鼠标还没碰到宠物就能点」。
             */
            const bodyOpaqueRect = (): PixelRect | null => {
                if (!atlas || atlas.alpha.frames.length === 0) return null;
                const base = animationOpaqueRect(atlas.plan, atlas.alpha.frames, currentAnimation);
                const look =
                    atlas.alpha.look && currentLook !== null && isIdleAnimation(currentAnimation)
                        ? lookOpaqueRect(atlas.plan, atlas.alpha.look, currentLook)
                        : null;
                return unionRect(base, look);
            };

            const measureBodyHitArea = (): HitArea | null => {
                const rect = elementRect(body);
                if (!rect) return null;
                const opaque = bodyOpaqueRect();
                return opaque ? bodyHitRect(rect, opaque) : rect;
            };

            const unregisterHitAreas = [
                registerHitArea(BODY_HIT_AREA_ID, measureBodyHitArea),
                registerHitAreaElement('pet-status', () => status),
                /* 卡片与面板互斥：隐藏的那个量出来是 0 尺寸，会被自动跳过 */
                registerHitAreaElement('pet-card', () => card),
                registerHitAreaElement('pet-panel', () => panel),
            ];

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
                    bubbleHintKey = '';
                }
                if (nextKey !== bubbleKey) {
                    bubbleKey = nextKey;
                    updateOverlays();
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
                        size,
                    );
                }
                if (disposed) return;
                /* 图集读到了才切成精灵形态；否则（确认没有图集）用程序化兜底圆形。
                   这一步在首帧之前完成，不会出现「先紫圆后精灵」。 */
                setBodyKind(atlas ? 'sprite' : 'fallback');
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
                updateOverlays();
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
                dismissSurface();
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
            /* 右键：没开 → 卡片；已经开着（卡片或面板）→ 收起。同一个状态机，纯函数可测。 */
            const onContextMenu = (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                setSurface(nextPetSurface(surface, 'contextmenu'));
            };
            /* 在卡片 / 面板上再右键一次同样收起（顺便挡掉 WebView 默认右键菜单） */
            const onSurfaceContextMenu = (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                setSurface(nextPetSurface(surface, 'contextmenu'));
            };
            const onWindowBlur = () => {
                endPress();
                setPetDragging(false);
                /* 失焦 = 用户去了别的窗口：收起浮层，但不要把焦点抢回来 */
                setSurface('none', false);
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
                    /* 窗口被隐藏：宿主那边不能继续拿旧矩形当热区 */
                    publishHitAreas(true);
                    /* 窗口可能随后被系统回收：把当前位置再记一次（R144） */
                    void (async () => {
                        const anchor = await measureAnchor();
                        if (!disposed && anchor) windowService.rememberPetAnchor(anchor);
                    })();
                } else {
                    publishHitAreas();
                    scheduleTick(0);
                }
            };
            /* 输入模态：键盘动过才允许画焦点环；一旦按指针就收回（宠物窗口里点击不留白框）。
               Esc 关掉浮层（对话框的标准退出方式，焦点回到本体）。 */
            const onDocumentKeyDown = (event: KeyboardEvent) => {
                if (root.dataset.modality !== 'keyboard') root.dataset.modality = 'keyboard';
                if (event.key !== 'Escape' || surface === 'none') return;
                event.preventDefault();
                event.stopPropagation();
                dismissSurface();
            };
            const onDocumentPointerModality = () => {
                if (root.dataset.modality !== 'pointer') root.dataset.modality = 'pointer';
            };
            const onDocumentPointerDown = (event: PointerEvent) => {
                const target = event.target;
                if (!(target instanceof Node)) return;
                /* 点在卡片 / 面板里 = 正在操作浮层；点其它任何地方（含本体）都收起 */
                if (card.contains(target) || panel.contains(target)) return;
                dismissSurface();
            };

            const runFeed = () => {
                dismissSurface();
                void interact('feed');
            };
            const runTouch = () => {
                dismissSurface();
                clicked = true;
                void interact('touch');
            };
            for (const button of [cardFeed, panelFeed]) button.addEventListener('click', runFeed);
            for (const button of [cardTouch, panelTouch]) button.addEventListener('click', runTouch);
            panelEntry.addEventListener('click', () => setSurface(nextPetSurface(surface, 'openPanel')));

            /* 尺寸的唯一一套控件：滑杆拖动实时应用、松手持久化（每帧写 localStorage 太贵）；
               数字框回车 / 失焦提交。两者写同一份尺寸状态，不存在「两套尺寸控件打架」。 */
            sizeSlider.addEventListener('input', () => applySize(Number(sizeSlider.value)));
            sizeSlider.addEventListener('change', () => {
                const next = clampPetSize(Number(sizeSlider.value));
                windowService.setPetSize(next);
                applySize(next);
            });
            const commitSizeInput = () => {
                const next = clampPetSize(Number(sizeNumber.value));
                sizeNumber.value = String(next);
                windowService.setPetSize(next);
                applySize(next);
            };
            sizeNumber.addEventListener('change', commitSizeInput);
            sizeNumber.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                /* 回车 = 提交：失焦会触发 change（number 输入的标准行为），这里不重复写一遍 */
                event.preventDefault();
                sizeNumber.blur();
            });
            roamButton.addEventListener('click', () => {
                roam = !roam;
                windowService.setPetRoam(roam);
                updateStatus();
            });
            hideButton.addEventListener('click', () => {
                dismissSurface();
                /* 隐藏前按脚底锚点记一次：从设置页关掉宠物时也用它回到原处；
                   同时把可交互区域清空（否则宿主会保留隐藏前的幽灵热区）。 */
                publishHitAreas(true);
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
            card.addEventListener('contextmenu', onSurfaceContextMenu);
            panel.addEventListener('contextmenu', onSurfaceContextMenu);
            document.addEventListener('pointerdown', onDocumentPointerDown);
            document.addEventListener('pointerdown', onDocumentPointerModality, true);
            document.addEventListener('keydown', onDocumentKeyDown, true);
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
                    if (surface !== 'none') {
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
                    card.removeEventListener('contextmenu', onSurfaceContextMenu);
                    panel.removeEventListener('contextmenu', onSurfaceContextMenu);
                    document.removeEventListener('pointerdown', onDocumentPointerDown);
                    document.removeEventListener('pointerdown', onDocumentPointerModality, true);
                    document.removeEventListener('keydown', onDocumentKeyDown, true);
                    document.removeEventListener('visibilitychange', onVisibilityChange);
                    window.removeEventListener('blur', onWindowBlur);
                    window.removeEventListener('resize', onWindowResize);
                    for (const unregister of unregisterHitAreas) unregister();
                    /* 卸载 = 窗口里再也没有可交互东西：必须发一条空列表，别把热区留在宿主那边 */
                    publishHitAreas(true);
                    sprite.style.backgroundImage = '';
                    root.remove();
                },
            };
        },
    };
}
















