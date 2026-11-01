import {useEffect, useState} from 'react';
import {PetHost, registerCorePet} from '../../pet';
import {PET_WINDOW_EVENTS, PET_WINDOW_POSITION_KEY, isTauri, windowService} from '../../services';
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
    const [payload, setPayload] = useState<PetWindowPayload>(EMPTY_PET_PAYLOAD);

    /* 订阅主窗口推送；`revision` 变了说明宠物被安装/切换/卸载，要重挂渲染器 */
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void (async () => {
            const {listen, emit} = await import('@tauri-apps/api/event');
            unlisten = await listen<PetWindowPayload>(PET_WINDOW_EVENTS.update, (event) => {
                if (!disposed && event.payload) setPayload(event.payload);
            });
            /* 告诉主窗口「我起来了」：事件不排队，第一次推送我们很可能错过了，
                不握手的话这里的 active 永远是 false，宠物就永远不画。 */
            void emit(PET_WINDOW_EVENTS.ready);
        })();
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    const revision = payload.revision;
    const active = payload.active;
    useEffect(() => {
        /* 注册渲染器：它在 mount 时读一次「当前出战是谁」，所以每次 revision 变化都重挂。
           关掉宠物时**不挂**：窗口虽然还在（隐藏），20Hz 的 tick 不该白跑。 */
        if (!active) return;
        const unregister = registerCorePet();
        return unregister;
    }, [active, revision]);

    /* 载荷变化 → 写进渲染器会读的那份快照 */
    useEffect(() => {
        publishPetWindowPayload(payload);
    }, [payload]);

    /* 记住用户拖动后的位置（主窗口下次显示时用）；失败不影响宠物。
       拖动是渲染器自己在挪窗口，`onMoved` 一秒能来几十次——**攒一下再写**，
       不然 localStorage 会被写得停不下来。 */
    useEffect(() => {
        if (!isTauri()) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        let timer: number | null = null;
        let latest: {x: number; y: number} | null = null;
        const flush = () => {
            timer = null;
            if (disposed || !latest) return;
            windowService.rememberPetPosition(latest);
        };
        void (async () => {
            const {getCurrentWindow} = await import('@tauri-apps/api/window');
            unlisten = await getCurrentWindow().onMoved(({payload: position}) => {
                if (disposed) return;
                latest = position;
                if (timer === null) timer = window.setTimeout(flush, 250);
            });
        })();
        return () => {
            disposed = true;
            unlisten?.();
            if (timer !== null) {
                window.clearTimeout(timer);
                flush();
            }
        };
    }, []);

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

export {PET_WINDOW_POSITION_KEY};

