import {useEffect, useRef, useState, type CSSProperties} from 'react';
import {useTranslation} from 'react-i18next';
import {backgroundService} from '../../../services';
import {useSelect} from '../../../store';
import {useTheme} from '../../../theme';
import {wrapWebWallpaper} from '../../../utils/backgroundWeb';
import {isMobilePlatform} from '../../../utils/platform';
import {useShellMode} from '../../../hooks/useShellMode';
import styles from './BackgroundVideo.module.css';

/**
 * 动态背景素材（可选）。
 *
 * `bgc.mp4` 体积较大（>100MB），**不入库**，需要本地测试时把它放回
 * `src/assets/bgc.mp4`（见 `src/assets/README.md`）。
 * 用 `import.meta.glob` 而非静态 import：文件缺失时构建不会失败，
 * 动态背景自动关闭，其余功能不受影响。
 */
/* 内置演示视频（`src/assets/bgc.mp4`）是个**虚拟模块**：`vite.config.ts` 的
   `bundledBackgroundPlugin` 在 android 构建里直接回 `null`，资源因此根本不会进产物
   ——APK 里不该出现一段 100 MB+ 的测试素材（R123）。桌面端照旧。 */
import bundledBgUrl from 'virtual:gently-bundled-bg';

const bgVideoUrl: string | null = bundledBgUrl;

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
    /* 手机形态（R122）：内容表面默认**不做毛玻璃**、且不透明度有下限——
       毛玻璃盖在会动的视频上既贵（每帧重绘整屏）又会让滚动中的文字压色块（用户反馈 #9「字体重叠」）。
       这是**默认值**，用户在设置里显式调过的仍然生效。 */
    const mobile = isMobilePlatform();
    const shellMode = useShellMode();
    /* 小尺寸外壳（手机 / 迷你播放器）的**视觉中心是封面与当前曲目**，不是壁纸。
       但两者的取舍不同（R139 用户反馈「手机导入背景还是白屏」）：
       - **迷你播放器**：表面不透明度给下限，否则一张人像照片会把封面和按钮淹没；
       - **手机**：不能用 0.92 的硬下限——那等于把背景盖成白板（默认 0.66 才看得到），
         文字可读性交给用户可调的「内容透明度」与背景自身的 scrim/opacity。
       两边的毛玻璃都默认关掉（滚动时省 GPU，也避免字压色块）。 */
    const mini = shellMode === 'mini';
    const MOBILE_CONTENT_OPACITY = 0.92;

    const videoRef = useRef<HTMLVideoElement>(null);
    const [objectUrl, setObjectUrl] = useState<string | null>(null);
    const [webHtml, setWebHtml] = useState<string | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);

    const isWeb = background.kind === 'web' && !mobile;
    /* 背景素材既可以是视频，也可以是图片（R139）：两者都存 IndexedDB `videos` store，
       靠 MIME / 扩展名区分渲染成 `<video>` 还是 `<img>`。 */
    const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
    const isImage =
        !isWeb &&
        !!background.asset &&
        (background.asset.type.startsWith('image/') || IMAGE_EXT.test(background.asset.name));
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

    /* 手机上下载/导入的素材才算数：**内置的演示视频不上手机**（R122）。
       它是一段 100 MB+ 的测试素材（`src/assets/README.md` 写的用途），
       在桌面端当背景没问题，手机上却是「启动就解码一个大文件」——
       背景迟迟不出现、首屏还更慢（用户反馈 #7「背景适配像加载过慢」）。
       没有导入素材时干脆不激活背景：外壳保持不透明，列表文字也不会压在彩色视频上（#9）。 */
    const videoSrc = isWeb ? null : background.asset ? objectUrl : mobile ? null : bgVideoUrl;
    const mediaReady = isWeb ? !!webHtml : !!videoSrc;
    /* 系统偏好只作默认：用户可以在设置里显式允许「减少动态效果时仍播放」。
       静态图片不受 reduced-motion 影响（它本来就不动）。 */
    const motionAllowed = !reduceMotion || background.playWhenReducedMotion;
    const active =
        enabled && background.enabled && (isImage || motionAllowed) && mediaReady && !loadFailed;

    /* 构图：`自由` 才启用锚点 / 缩放 / 翻转；其余对齐方式用标准 object-fit，
       避免「选了铺满却还被旧参数拉偏」。 */
    const free = background.options.fit === 'free';
    const transforms: string[] = [];
    if (free && background.options.scale !== 1) {
        transforms.push(`scale(${background.options.scale})`);
    }
    if (free && background.options.flip) {
        transforms.push('scaleX(-1)');
    }
    const mediaStyle: CSSProperties = {
        objectFit:
            background.options.fit === 'free' ? 'cover' : background.options.fit,
        objectPosition: free
            ? `${background.options.positionX}% ${background.options.positionY}%`
            : '50% 50%',
        transform: transforms.length > 0 ? transforms.join(' ') : undefined,
        transformOrigin: 'center center',
    };

    /* 用户预设只覆盖自己改过的值；null 继续跟随主题 token */
    const layerStyle: CSSProperties & Record<string, string> = {};
    if (background.options.opacity !== null) {
        layerStyle['--bg-video-opacity'] = String(background.options.opacity);
    } else if (mobile) {
        /* 手机默认把壁纸本体放到 0.75：内容面板已经压了一层，背景本体再暗就真的看不见 */
        layerStyle['--bg-video-opacity'] = '0.75';
    }
    /* 手机关掉壁纸自身的模糊：用户反馈「背景仍然是模糊」——移动端优先看清内容，
       模糊在桌面端仍可按预设调。 */
    if (mobile) {
        layerStyle['--bg-video-blur'] = '0px';
    } else if (background.options.blurPx !== null) {
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
        const rawOpacity =
            background.options.contentOpacity ?? config.components.background.contentOpacity;
        /* 手机默认用 0.35（而不是主题的 0.66）：只有用户显式调过才用他的值。
           之前 0.92 的下限把背景盖成白板，用户反馈「导入背景仍然白屏」就是它。 */
        const mobileDefaultOpacity = 0.35;
        const mobileCap = 0.5;
        const opacity = mini
            ? Math.max(rawOpacity, MOBILE_CONTENT_OPACITY)
            : mobile
              ? Math.min(
                    background.options.contentOpacity === null
                        ? mobileDefaultOpacity
                        : rawOpacity,
                    mobileCap,
                )
              : rawOpacity;
        /* 手机强制关掉内容毛玻璃：背景被 backdrop-filter 模糊也是「看不清背景」的原因之一 */
        const blur =
            mobile || mini
                ? 0
                : background.options.contentBlurPx ??
                  config.components.background.surfaceBlurPx;
        const rawDrawerOpacity =
            background.options.drawerOpacity ?? config.components.background.drawerOpacity;
        const drawerOpacity = mini
            ? Math.max(rawDrawerOpacity, MOBILE_CONTENT_OPACITY)
            : rawDrawerOpacity;
        const drawerBlur =
            mobile || mini
                ? 0
                : background.options.drawerBlurPx ??
                  config.components.background.drawerBlurPx;
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
        mobile,
        mini,
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
            ) : isImage && objectUrl ? (
                <img
                    key={objectUrl}
                    className={styles.video}
                    src={objectUrl}
                    alt=""
                    style={mediaStyle}
                    onError={() => setLoadFailed(true)}
                />
            ) : (
                videoSrc && (
                    <video
                        key={videoSrc}
                        ref={videoRef}
                        className={styles.video}
                        src={videoSrc}
                        style={mediaStyle}
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
