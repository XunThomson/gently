/**
 * 宠物域的前端门面（`pet_invoke` 宿主命令）。
 *
 * 与音乐核心**并列**而不是它的分支（ADR 0010）：
 * - 入口是 `pet_invoke{command, params}`，由 `pet_core::dispatch` 路由；
 * - 信封形状与音乐核心一致（`{ok, data|error, traceId}`），但错误码是宠物域自己的 `pet.*`；
 * - 浏览器预览没有宿主：一律返回 `pet` 域的 `unsupported_platform` 语义（见 `petUnavailable`），
 *   调用方据此不渲染宠物，而不是拿假数据冒充。
 */
import {coreAvailable} from './core.bridge';

/** 宠物域信封（形状与音乐核心一致；错误码是 `pet.*`） */
export interface PetEnvelope<T> {
    ok: boolean;
    data?: T;
    error?: {code: string; message: string};
    traceId?: string;
}

/** 图集的网格布局（有它时按「格子」取帧；没有时按「单行帧条」等分整图） */
export interface PetAtlasLayoutDto {
    frameWidth: number;
    frameHeight: number;
    columns: number;
    rows: number;
}

/** 某一行的显示适配（解决「同一张图集里各行画得大小不一」，见 docs/pet-package.md） */
export interface PetAnimationFitDto {
    /** 相对整格的倍数（1 = 原样） */
    scale?: number | null;
    /** 原图像素为单位的微调 */
    offsetX?: number | null;
    offsetY?: number | null;
}

/** 宠物规格（`pet.json`，M1 只需要读这几位；结构校验在核心） */
export interface PetAnimationDto {
    name: string;
    frames: number;
    frameMs: number;
    loop?: boolean;
    /** 网格图集里的行号（不写按声明顺序） */
    row?: number | null;
    /** 该行的显示适配（可选） */
    fit?: PetAnimationFitDto | null;
    /**
     * 该行动画允许的位移能力（R139）：`walk` 才能平移窗口，`none`（坐下/跳/失败）
     * 必须原地播放。不声明时遵循旧包兼容规则（整包全 walk）。
     */
    motion?: 'none' | 'walk' | 'crawl' | null;
}

export interface PetSpecDto {
    id: string;
    name: string;
    version: string;
    author?: string;
    atlas?: string;
    atlasLayout?: PetAtlasLayoutDto | null;
    /** 「看向哪边」的两行（16 个方向，0 = 正上、顺时针）；没有就不支持 look */
    lookRows?: [number, number] | null;
    animations: PetAnimationDto[];
    behaviors?: unknown[];
    minPetCoreVersion?: string;
}

/** 跨会话资料（好感度 / 饱食度） */
export interface PetProfileDto {
    id: string;
    name: string;
    affection: number;
    hunger: number;
    lastFedAt: number;
    lastTouchedAt: number;
    createdAt: number;
    updatedAt: number;
}

/** 养成账本（R139）：等级/经验/次数/连续天数/解锁 */
export interface PetGrowthDto {
    xp: number;
    level: number;
    nextLevelXp: number;
    feeds: number;
    touches: number;
    bestAffection: number;
    streakDays: number;
    daysVisited: number;
    todayFed: number;
    todayTouched: number;
    unlocked: string[];
}

/** 一帧（渲染层只读它） */
export interface PetFrameDto {
    animation: number;
    frame: number;
    x: number;
    y: number;
    flip: boolean;
    bubble: number | null;
    /** 看向哪边（原样回传 lookDir；没有就是 null） */
    look: number | null;
    /** 当前动画允许的位移能力（R139；宿主据此决定能不能平移窗口） */
    motion?: 'none' | 'walk' | 'crawl';
    hitArea: {x: number; y: number; w: number; h: number} | null;
}

/** 好感分档（派生值，与核心的 `PetMood` 一致） */
export type PetMoodDto = 'shy' | 'friendly' | 'close' | 'devoted';

export interface PetStateDto {
    active: string | null;
    /** 宠物核心的版本（`pet-core` 的 Cargo 版本）：界面上回答「这个包装得上吗」 */
    coreVersion: string;
    pets: {
        id: string;
        name: string;
        version: string;
        active: boolean;
        /** 好感分档（由好感算出，不落库） */
        mood: PetMoodDto;
        /** 是否饿到该有反应了（阈值在核心里） */
        hungry: boolean;
        spec: PetSpecDto;
        profile: PetProfileDto;
        /** 养成账本（等级/经验/连续天数/解锁） */
        growth: PetGrowthDto;
    }[];
    dataDir: string;
    dbPath: string;
    schemaVersion: number;
}

export interface PetTickResult {
    frame: PetFrameDto;
    bubble: {index: number; key: string} | null;
}

export interface PetTickInput {
    petId: string;
    dtMs: number;
    playing?: boolean;
    elapsedMs?: number;
    lyricActive?: boolean;
    trackHash?: number;
    pointerX?: number | null;
    pointerY?: number | null;
    clicked?: boolean;
    /** 指针相对宠物的方向（0..15，0 = 正上、顺时针） */
    lookDir?: number | null;
    /** 正在往哪边走（-1 左 / 1 右；不传 = 没在走） */
    walkDir?: number | null;
}

/** 没有宿主时的统一失败（与音乐核心的 `unsupported_platform` 同一语义） */
function petUnavailable<T>(): PetEnvelope<T> {
    return {
        ok: false,
        error: {code: 'common.unsupported_platform', message: '当前不在桌面宿主中，宠物不可用'},
        traceId: 'client',
    };
}

/** 调一条宠物命令；永不抛异常（失败也走信封）。 */
export async function petInvoke<T>(
    command: string,
    params: Record<string, unknown> = {},
): Promise<PetEnvelope<T>> {
    if (!coreAvailable()) return petUnavailable<T>();
    try {
        const {invoke} = await import('@tauri-apps/api/core');
        const result = await invoke<PetEnvelope<T>>('pet_invoke', {command, params});
        if (result && typeof result === 'object' && 'ok' in result) return result;
        return {
            ok: false,
            error: {code: 'pet.internal', message: '宠物命令没有返回契约信封'},
            traceId: 'client',
        };
    } catch (err) {
        return {
            ok: false,
            error: {code: 'pet.internal', message: err instanceof Error ? err.message : String(err)},
            traceId: 'client',
        };
    }
}

/**
 * 宠物域错误码（与 `pet-core/src/error.rs` 的 `as_str()` 一一对应）。
 *
 * 界面上**不要**直接显示 `error.message`：那是给开发者看的说明（而且只有中文）。
 * 用 `errorText(t, error)` 查 `errors.pet_*` 文案，再由冒烟测试守着「每个码都有 zh/en」。
 */
export const PET_ERROR_CODES = [
    'pet.invalid_argument',
    'pet.not_found',
    'pet.invalid_package',
    'pet.incompatible',
    'pet.limit_exceeded',
    'pet.io_error',
    'pet.internal',
] as const;

export const petService = {
    /** 出战宠物 + 全部已安装（单宠物展示，多宠物存储） */
    state: () => petInvoke<PetStateDto>('pet.state'),

    /**
     * 安装（或覆盖）一个宠物包。
     *
     * `spec` 传 **JSON 原文**：解析与校验都在核心里（前端不预解析，
     * 否则「前端说合法、核心说非法」会变成两种真相）。
     * `atlas` 可选：`{file, dataBase64}`，核心只收 png/webp、纯文件名、≤ 8 MiB。
     */
    install: (spec: string, atlas?: {file: string; dataBase64: string}) =>
        petInvoke<{spec: PetSpecDto; active: string | null; hasAtlas: boolean}>(
            'pet.install',
            atlas ? {spec, atlas} : {spec},
        ),

    /** 取宠物图集（没有图集回 `null`；失败照常走信封） */
    atlas: (id: string) =>
        petInvoke<{file: string; dataBase64: string} | null>('pet.atlas', {id}),

    setActive: (id: string) => petInvoke<{active: string | null}>('pet.setActive', {id}),

    /** 推进一帧（宿主按时钟调用；M1 约定 20 Hz） */
    tick: (input: PetTickInput) => petInvoke<PetTickResult>('pet.tick', {...input}),

    /** 喂食（冷却内报错）/ 触摸（冷却内静默） */
    interact: (id: string, kind: 'feed' | 'touch') =>
        petInvoke<{
            profile: PetProfileDto;
            mood: PetMoodDto;
            hungry: boolean;
            growth: PetGrowthDto;
        }>('pet.interact', {
            id,
            kind,
        }),

    remove: (id: string) => petInvoke<{removed: boolean; active: string | null}>('pet.remove', {id}),
};




