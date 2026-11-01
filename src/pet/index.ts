import {createCorePet} from './core-pet';
import {registerPet} from './registry';

/**
 * 注册**宠物渲染器**（M2）：一个适配器画「当前出战的那只」。
 *
 * 只在「实验开关」打开时由 App 调用：宠物是 2.x 的产品形态，音乐软件现在仍在 1.x，
 * 所以默认什么都不注册（`PetHost` 会渲染 null，零成本）。
 *
 * 返回注销函数。**切换/安装/卸载宠物后要重新注册一次**（渲染器在 mount 时读一次出战信息），
 * 这就是设置页在每次改动后调用它的原因——见 `PetCard`。
 */
export function registerCorePet(): () => void {
    return registerPet(createCorePet());
}

export {createCorePet} from './core-pet';
export {PetHost} from './PetHost';
export {createPetContext, petPlaybackSnapshot} from './context';
export {
    registerPet,
    listPets,
    subscribePets,
    petsRevision,
    clearPets,
} from './registry';
export type {
    PetDefinition,
    PetInstance,
    PetContext,
    PetPlaybackSnapshot,
} from './types';
