import {useEffect, useState} from 'react';
import {PetHost, registerCorePet} from '../../pet';
import {PET_WINDOW_EVENTS, isTauri, windowService} from '../../services';
import {publishPetWindowPayload, petWindowContext} from './pet-window-context';
import {EMPTY_PET_PAYLOAD, type PetWindowPayload} from './types';
import styles from './pet-window.module.css';

/**
 * 宠物窗口（`pet`，独立 Tauri 窗口）。
 *
 * 关键点：宠物**不再住在音乐软件的窗口里**——它是自己的置顶小窗，
 * 主窗口最小化、被别的应用盖住、或者缩到任务栏时它都还在（桌宠形态）。
 *
 * 数据从哪来：主窗口通过窗口间事件推一份**只读播放快照**（见 `usePetWindowBridge`），
 * 这里写进 `petWindowContext` 给渲染器；宠物自己的状态（好感/饥饿/动画）仍然只走 `pet-core`。
 *
 * 拖动只有一条路：**直接拖宠物本体**（渲染器里按住移动超过 5px 才开始拖窗口）。
 * R102 之前顶部还有一条透明拖动条，但它离宠物很远，拖起来像在拖一个看不见的窗口（反直觉），
 * R103 去掉了：现在窗口里唯一可交互的地方就是宠物自己，其余透明区域点击穿透。
 */
export function PetWindowApp() {
    const [control, setControl] = useState({active: EMPTY_PET_PAYLOAD.active, revision: EMPTY_PET_PAYLOAD.revision});

    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void (async () => {
            const {listen, emit} = await import('@tauri-apps/api/event');
            const off = await listen<PetWindowPayload>(PET_WINDOW_EVENTS.update, (event) => {
                if (disposed || !event.payload) return;
                publishPetWindowPayload(event.payload);
                const {active, revision} = event.payload;
                setControl((previous) =>
                    previous.active === active && previous.revision === revision ? previous : {active, revision},
                );
            });
            if (disposed) off();
            else unlisten = off;
            void emit(PET_WINDOW_EVENTS.ready);
        })();
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        if (!control.active) return;
        return registerCorePet();
    }, [control.active, control.revision]);

    /* 用户把宠物窗口关掉时，通知主窗口把开关也关掉
       （否则会出现「设置里说开着、窗口却不见了」这种自相矛盾的状态） */
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void (async () => {
            const {getCurrentWindow} = await import('@tauri-apps/api/window');
            unlisten = await getCurrentWindow().onCloseRequested(() => {
                if (!disposed) windowService.notifyPetWindowClosed();
            });
        })();
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    return (
        <div className={styles.page} data-pet-window="">
            <PetHost context={petWindowContext} />
        </div>
    );
}
