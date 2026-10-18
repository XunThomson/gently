import {useEffect, useMemo, useRef, useSyncExternalStore} from 'react';
import {createPetContext} from './context';
import {listPets, petsRevision, subscribePets} from './registry';
import styles from './pet.module.css';

/**
 * 宠物宿主（2.x 预留，当前为空）。
 *
 * 挂载在应用外壳里：没有注册宠物时渲染 `null`（零成本）；
 * 有宠物时给一个覆盖全屏、默认 `pointer-events: none` 的容器，
 * 由宠物自己决定哪些元素可交互。单个宠物 `mount` 抛错只跳过它。
 */
export function PetHost() {
    const revision = useSyncExternalStore(subscribePets, petsRevision, petsRevision);
    const pets = useMemo(() => listPets(), [revision]);
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const container = hostRef.current;
        if (!container || pets.length === 0) return;

        const context = createPetContext();
        const instances = pets.map((pet) => {
            try {
                return pet.mount(container, context);
            } catch (err) {
                console.warn(`[pet] 挂载失败：${pet.id}`, err);
                return {dispose: () => undefined};
            }
        });

        return () => {
            for (const instance of instances) {
                try {
                    instance.dispose();
                } catch (err) {
                    console.warn('[pet] 卸载失败', err);
                }
            }
        };
    }, [pets]);

    if (pets.length === 0) return null;
    return <div ref={hostRef} className={styles.host} data-pet-host="" />;
}
