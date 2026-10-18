import type {PetDefinition} from './types';

/**
 * 宠物注册表（2.x 预留）。
 *
 * 当前版本**没有**注册任何宠物，`PetHost` 因此不渲染任何东西；
 * 2.x 的内置宠物或用户导入实现通过 `registerPet()` 进入，宿主自动挂载。
 * 注册表变化会通知宿主（`useSyncExternalStore`），所以宠物可以在运行期增删。
 */

const pets = new Map<string, PetDefinition>();
const listeners = new Set<() => void>();
let revision = 0;

function notify() {
    revision += 1;
    for (const listener of listeners) listener();
}

/** 注册（同 id 覆盖）一个宠物；返回注销函数 */
export function registerPet(pet: PetDefinition): () => void {
    if (!pet.id.trim()) throw new Error('宠物 id 不能为空');
    pets.set(pet.id, pet);
    notify();
    return () => {
        if (pets.get(pet.id) === pet) {
            pets.delete(pet.id);
            notify();
        }
    };
}

/** 当前已注册的宠物（稳定顺序 = 注册顺序） */
export function listPets(): PetDefinition[] {
    return [...pets.values()];
}

/** 供 React `useSyncExternalStore` 订阅注册表变化 */
export function subscribePets(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** 注册表版本号（`useSyncExternalStore` 的快照；只增不减） */
export function petsRevision(): number {
    return revision;
}

/** 清空注册表（测试与热重载用；2.x 应用启动时不需要手动调用） */
export function clearPets(): void {
    if (pets.size === 0) return;
    pets.clear();
    notify();
}
