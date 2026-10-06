import {useEffect} from 'react';
import bgVideoUrl from '../../../assets/bgc.mp4';
import {themeConfig} from '../../../theme';
import styles from './BackgroundVideo.module.css';

/**
 * 动态背景：铺满整个应用视图的视频层。
 *
 * - 视频以 `object-fit: cover` 铺满；透明度 / 模糊 / 遮罩都由主题 token 控制
 *   （`components.background` → `--bg-video-opacity` / `--bg-video-blur` / `--bg-video-scrim`）；
 * - 挂载时在 `<html>` 上打 `data-video-bg="on"`，外壳据此切换到半透明表面
 *   （见 global.css 的 `--surface-chrome`），实现「玻璃化」效果；
 * - `prefers-reduced-motion` 下不渲染视频，避免不适。
 */
export function BackgroundVideo() {
    const {enabled} = themeConfig.components.background;

    const reduceMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const active = enabled && !reduceMotion;

    useEffect(() => {
        const root = document.documentElement;
        if (active) root.dataset.videoBg = 'on';
        else delete root.dataset.videoBg;

        return () => {
            delete root.dataset.videoBg;
        };
    }, [active]);

    if (!active) return null;

    return (
        <div className={styles.layer} aria-hidden="true">
            <video
                className={styles.video}
                src={bgVideoUrl}
                autoPlay
                muted
                loop
                playsInline
                preload="auto"
            />
            <div className={styles.scrim}/>
        </div>
    );
}

export default BackgroundVideo;
