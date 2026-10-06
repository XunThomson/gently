import {useEffect} from 'react';
import {useTheme} from '../../../theme';
import styles from './BackgroundVideo.module.css';

/**
 * 动态背景素材（可选）。
 *
 * `bgc.mp4` 体积较大（>100MB），**不入库**，需要本地测试时把它放回
 * `src/assets/bgc.mp4`（见 `src/assets/README.md`）。
 * 用 `import.meta.glob` 而非静态 import：文件缺失时构建不会失败，
 * 动态背景自动关闭，其余功能不受影响。
 */
const backgroundVideos = import.meta.glob<string>('../../../assets/bgc.mp4', {
    eager: true,
    query: '?url',
    import: 'default',
});

const bgVideoUrl: string | null = Object.values(backgroundVideos)[0] ?? null;

/**
 * 动态背景：铺满整个应用视图的视频层。
 *
 * - 视频以 `object-fit: cover` 铺满；透明度 / 模糊 / 遮罩都由主题 token 控制
 *   （`components.background` → `--bg-video-opacity` / `--bg-video-blur` / `--bg-video-scrim`）；
 * - 挂载时在 `<html>` 上打 `data-video-bg="on"`，外壳据此切换到「半透明 + 背景模糊」的
 *   玻璃化表面（见 global.css 的 `--surface-chrome` / `--surface-blur`）；
 * - `prefers-reduced-motion` 下不渲染视频，避免不适。
 */
export function BackgroundVideo() {
    const {config} = useTheme();
    const {enabled} = config.components.background;

    const reduceMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const active = enabled && !!bgVideoUrl && !reduceMotion;

    useEffect(() => {
        if (enabled && !bgVideoUrl && import.meta.env.DEV) {
            console.info(
                '[background] 未找到 src/assets/bgc.mp4，动态背景已关闭；' +
                    '需要本地测试请把测试视频放回该路径（见 src/assets/README.md）。',
            );
        }
    }, [enabled]);

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
