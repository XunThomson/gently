import {useEffect} from 'react';
import {useActions, useSelect} from '../store';

/**
 * 下载引擎：把「进度推进」这一副作用从 UI 与 state 中隔离出来。
 * 应用内只需挂载一次（App 中调用）；只有存在下载中的任务时才会起定时器。
 */
export function useDownloadEngine(): void {
    const active = useSelect((s) =>
        s.download.tasks.some((task) => task.status === 'downloading'),
    );
    const tick = useActions().download.tick;

    useEffect(() => {
        if (!active) return;
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
    }, [active, tick]);
}
