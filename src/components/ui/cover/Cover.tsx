import {coverStyle, coverUrl} from '../../../utils/cover';
import styles from './cover.module.css';

interface Props {
    /** 封面地址（插件/核心给的原始值，可能带 `http:` 或协议相对前缀） */
    artwork?: string;
    /** 没有图片时的渐变占位 */
    gradient?: string;
    /** 没有图片时的哈希种子（标题 + 歌手） */
    title: string;
    artist: string;
    /** 外框尺寸/圆角来自调用方（列表 40px、榜单 44px…），本组件只管「怎么把图放进去」 */
    className?: string;
    /** 叠在封面上层的内容（例如榜单的播放动画、占位字符） */
    children?: React.ReactNode;
}

/**
 * 封面：**有地址就渲染 `<img>`，没有才退回渐变**。
 *
 * 为什么不用 `background-image`：
 * 1. 桌面宿主的页面（`http://tauri.localhost`）里，背景图请求带出去的 Referer 会被部分图床
 *    （实测 B 站 `i0/i1.hdslb.com`）判成盗链直接回 **403**；`<img>` 上可以显式声明
 *    `referrerPolicy="no-referrer"`——按请求生效，比整页策略可靠；
 * 2. `<img>` 能拿到加载失败事件（背景图拿不到），失败时把图藏掉、露出渐变底，不会出现破图；
 * 3. `loading="lazy"` / `decoding="async"` 让长列表不必一次拉几十张图。
 */
export function Cover({artwork, gradient, title, artist, className, children}: Props) {
    const url = coverUrl(artwork);
    const box = className ? `${className} ${styles.box}` : styles.box;

    return (
        <span
            aria-hidden="true"
            className={box}
            style={coverStyle(gradient, `${title}|${artist}`)}
        >
            {url && (
                <img
                    className={styles.image}
                    src={url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={(event) => {
                        /* 图床拒绝/超时：藏掉图片，父级渐变底露出来 */
                        event.currentTarget.style.display = 'none';
                    }}
                />
            )}
            {children}
        </span>
    );
}
