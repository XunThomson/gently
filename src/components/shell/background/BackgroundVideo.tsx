import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {useTranslation} from 'react-i18next';
import {backgroundService} from '../../../services';
import {useSelect} from '../../../store';
import {useTheme} from '../../../theme';
import {wrapWebWallpaper} from '../../../utils/backgroundWeb';
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
 * 动态背景：铺满整个应用视图。
 *
 * 来源优先级：
 * 1. 用户在设置里导入的本地视频（Blob 存 IndexedDB）；
 * 2. 单文件静态网页壁纸（HTML 存 IndexedDB，空 sandbox + CSP 渲染；脚本/外链不执行）；
 * 3. 随包/本地测试用的 `bgc.mp4`；
 * 4. 都没有 → 不渲染，外壳保持不透明。
 *
 * 透明度 / 模糊默认取主题 token；用户预设里的数值覆盖到本层的 CSS 变量上。
 * `prefers-reduced-motion` 默认关闭，但用户可在设置里显式覆盖。
 */
export function BackgroundVideo() {
    const {t} = useTranslation();
    const {config} = useTheme();
    const background = useSelect((state) => state.ui.background);
    const {enabled} = config.components.background;

    const videoRef = useRef<HTMLVideoElement>(null);
    const [objectUrl, setObjectUrl] = useState<string | null>(null);
    const [webHtml, setWebHtml] = useState<string | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);

    const isWeb = background.kind === 'web';
    const reduceMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* 用户视频：按 asset.id 从 IndexedDB 取 Blob，再转成本次会话的 object URL */
    useEffect(() => {
        setLoadFailed(false);
        setObjectUrl(null);
        if (isWeb || !background.asset) return;

        let cancelled = false;
        let created: string | null = null;
        void backgroundService.load(background.asset.id).then((blob) => {
            if (cancelled) return;
            if (!blob) {
                setLoadFailed(true);
                return;
            }
            created = URL.createObjectURL(blob);
            setObjectUrl(created);
        });

        return () => {
            cancelled = true;
            if (created) URL.revokeObjectURL(created);
        };
    }, [background.asset?.id, isWeb]);

    /* 网页壁纸：按 web.id 取 HTML 文本 */
    useEffect(() => {
        setLoadFailed(false);
        setWebHtml(null);
        if (!isWeb || !background.web) return;

        let cancelled = false;
        void backgroundService.loadWeb(background.web.id).then((html) => {
            if (cancelled) return;
            if (!html) {
                setLoadFailed(true);
                return;
            }
            setWebHtml(html);
        });
        return () => {
            cancelled = true;
        };
    }, [background.web?.id, isWeb]);

    const videoSrc = isWeb ? null : background.asset ? objectUrl : bgVideoUrl;
    const mediaReady = isWeb ? !!webHtml : !!videoSrc;
    /* 系统偏好只作默认：用户可以在设置里显式允许「减少动态效果时仍播放」 */
    const motionAllowed = !reduceMotion || background.playWhenReducedMotion;
    const active =
        enabled && background.enabled && motionAllowed && mediaReady && !loadFailed;

    /* 用户预设只覆盖自己改过的值；null 继续跟随主题 token */
    const layerStyle: CSSProperties & Record<string, string> = {};
    if (background.options.opacity !== null) {
        layerStyle['--bg-video-opacity'] = String(background.options.opacity);
    }
    if (background.options.blurPx !== null) {
        layerStyle['--bg-video-blur'] = `${background.options.blurPx}px`;
    }

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        video.playbackRate = background.options.playbackRate;
    }, [objectUrl, background.options.playbackRate]);

    /*
     * 窗口失焦 / 最小化时**暂停视频**，而不是卸载背景：
     * 用户希望切出去再回来时壁纸还在，只是不要在后台继续解码。
     * 网页壁纸没有可靠的外部暂停信号（静态 iframe 无 JS 控制），保持挂载；
     * iframe 自身的动画仍受沙箱内容控制，但不会让应用丢失背景。
     */
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !active || isWeb) return;
        const sync = () => {
            if (document.hidden || !document.hasFocus()) video.pause();
            else void video.play().catch(() => undefined);
        };
        sync();
        window.addEventListener('focus', sync);
        window.addEventListener('blur', sync);
        document.addEventListener('visibilitychange', sync);
        return () => {
            window.removeEventListener('focus', sync);
            window.removeEventListener('blur', sync);
            document.removeEventListener('visibilitychange', sync);
        };
    }, [active, videoSrc, isWeb]);

    /* 内容表面透明度/虚化：只改表面 token，文字/图标不受影响 */
    useEffect(() => {
        const root = document.documentElement;
        const opacity =
            background.options.contentOpacity ?? config.components.background.contentOpacity;
        const blur =
            background.options.contentBlurPx ?? config.components.background.surfaceBlurPx;
        const drawerOpacity =
            background.options.drawerOpacity ?? config.components.background.drawerOpacity;
        const drawerBlur =
            background.options.drawerBlurPx ?? config.components.background.drawerBlurPx;
        const mix = (base: string, value: number) => {
            const percent = Math.round(value * 100);
            return percent >= 100
                ? `var(${base})`
                : `color-mix(in srgb, var(${base}) ${percent}%, transparent)`;
        };
        if (active) {
            root.style.setProperty('--surface-chrome', mix('--bg-surface', opacity));
            root.style.setProperty('--surface-content', mix('--bg-surface', opacity));
            root.style.setProperty('--surface-content-alt', mix('--bg-surface-alt', opacity));
            root.style.setProperty('--surface-elevated', mix('--bg-elevated', opacity));
            root.style.setProperty('--surface-drawer', mix('--bg-elevated', drawerOpacity));
            root.style.setProperty(
                '--surface-blur',
                blur > 0 ? `blur(${Math.round(blur)}px) saturate(140%)` : 'none',
            );
            root.style.setProperty(
                '--surface-drawer-blur',
                drawerBlur > 0 ? `blur(${Math.round(drawerBlur)}px) saturate(140%)` : 'none',
            );
        } else {
            root.style.removeProperty('--surface-chrome');
            root.style.removeProperty('--surface-content');
            root.style.removeProperty('--surface-content-alt');
            root.style.removeProperty('--surface-elevated');
            root.style.removeProperty('--surface-drawer');
            root.style.removeProperty('--surface-blur');
            root.style.removeProperty('--surface-drawer-blur');
        }
        return () => {
            root.style.removeProperty('--surface-chrome');
            root.style.removeProperty('--surface-content');
            root.style.removeProperty('--surface-content-alt');
            root.style.removeProperty('--surface-elevated');
            root.style.removeProperty('--surface-drawer');
            root.style.removeProperty('--surface-blur');
            root.style.removeProperty('--surface-drawer-blur');
        };
    }, [
        active,
        background.options.contentOpacity,
        background.options.contentBlurPx,
        background.options.drawerOpacity,
        background.options.drawerBlurPx,
        config.components.background.contentOpacity,
        config.components.background.surfaceBlurPx,
        config.components.background.drawerOpacity,
        config.components.background.drawerBlurPx,
    ]);

    useEffect(() => {
        if (enabled && !bgVideoUrl && import.meta.env.DEV && !background.asset && !isWeb) {
            console.info(
                '[background] 未找到 src/assets/bgc.mp4，动态背景已关闭；' +
                    '需要本地测试请把测试视频放回该路径（见 src/assets/README.md）。',
            );
        }
    }, [enabled, background.asset, isWeb]);

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
        <div className={styles.layer} style={layerStyle} aria-hidden="true">
            {isWeb && webHtml ? (
                <iframe
                    className={styles.frame}
                    title={t('page.background.webFrameTitle')}
                    sandbox=""
                    tabIndex={-1}
                    referrerPolicy="no-referrer"
                    srcDoc={wrapWebWallpaper(webHtml)}
                />
            ) : (
                videoSrc && (
                    <video
                        key={videoSrc}
                        ref={videoRef}
                        className={styles.video}
                        src={videoSrc}
                        style={{objectFit: background.options.fit}}
                        autoPlay
                        muted
                        loop
                        playsInline
                        preload="auto"
                        onError={() => setLoadFailed(true)}
                    />
                )
            )}
            <div className={styles.scrim}/>
        </div>
    );
}

export default BackgroundVideo;
