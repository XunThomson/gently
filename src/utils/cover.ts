import type {CSSProperties} from 'react';
import {grad, hashStr} from './helpers';

/**
 * 封面渲染。
 *
 * 两种来源的封面**形状不同**，这里统一收口：
 * - 核心（真实源）给的是**图片地址**（`http(s)://` 或 `data:`）→ 用 `background-image`；
 * - 浏览器预览给的是**渐变色**（mock 占位）→ 用 `background`；
 * - 两者都没有（核心对推荐结果返回空 `cover`）→ 用**稳定哈希**挑一个渐变兜底，
 *   而不是留一块透明方块。
 *
 * 同一个算法只有这一份，网格与详情页共用。
 */
/**
 * 把封面地址规范成**可直接加载**的 https URL；不是图片地址（渐变、空串）时返回 `null`。
 *
 * 桌面端页面跑在 `http://tauri.localhost`，属于安全上下文，于是：
 * - `http://…` 的图会被当**混合内容**直接拦掉（上游插件给的就是 `http://i1.example.com/…`）；
 * - `//host/…` 会被解析成 `tauri://host/…`。
 * 两种情况都表现为「封面静默加载失败、退回渐变色块」，看起来像「没有封面」（R73）。
 */
export function coverUrl(cover: string | undefined): string | null {
    const value = (cover ?? '').trim();
    const remote = value.startsWith('//')
        ? `https:${value}`
        : /^http:\/\//i.test(value)
          ? `https://${value.slice(7)}`
          : value;
    if (value.startsWith('data:')) return value;
    return /^https:\/\//i.test(remote) ? remote : null;
}

export function coverStyle(cover: string | undefined, seed: string): CSSProperties {
    const value = (cover ?? '').trim();
    const url = coverUrl(value);

    if (url) {
        return {
            backgroundImage: `url("${url}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
        };
    }

    // 渐变（或任何 CSS background 值）直接透传；空值才用哈希兜底
    return {background: value || grad(hashStr(seed))};
}

/**
 * 曲目封面：**优先用插件给的封面图**（`artwork`），没有才退回渐变占位。
 *
 * 单独一个函数是为了让「曲目封面」这件事只有一个地方决定优先级——
 * 曲目在网格、榜单、播放条、歌词页、相似推荐等 6 处渲染，各写一遍迟早会不一致。
 */
export function trackCoverStyle(track: {
    artwork?: string;
    gradient?: string;
    title: string;
    artist: string;
}): CSSProperties {
    return coverStyle(track.artwork || track.gradient, `${track.title}|${track.artist}`);
}
