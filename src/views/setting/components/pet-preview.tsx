import {useEffect, useRef} from 'react';
import {petService} from '../../../services';
import type {PetSpecDto} from '../../../services/core.pet';
import {decodeAtlas, drawAtlasFrame} from '../../../pet/atlas-image';
import styles from '../setting.module.css';

/**
 * 宠物缩略预览：用**图集本身**画一小段待机动画。
 *
 * 为什么值得做：设置页现在只显示「名字 / 版本 / 好感」，用户根本看不出装的是哪只宠物；
 * 而图集就在本地（`pet.atlas`），顺手画出来比再存一张缩略图便宜。
 *
 * 关键点：
 * - 每帧从**原图**里取格子再缩放（`drawAtlasFrame`），不用 `background-position`，
 *   这样预览与宠物窗口的取帧逻辑共用一份，不会「设置页看着对、桌面上画错」；
 * - 画布内部尺寸是显示尺寸的 2 倍（96×104），配合 `image-rendering: pixelated` 在高 DPI 下也清晰；
 * - 解码一次就缓存（按 `id@version`），切页再回来不重复解码那张 1-3 MB 的图；
 * - 取不到图集（没有图集 / 读失败）就退化成一个小圆点，不显示假图。
 */

interface DecodedCacheEntry {
    promise: Promise<Awaited<ReturnType<typeof decodeAtlas>>>;
}

const cache = new Map<string, DecodedCacheEntry>();

function loadDecoded(spec: PetSpecDto, petId: string) {
    const key = `${petId}@${spec.version}`;
    const existing = cache.get(key);
    if (existing) return existing.promise;
    const promise = (async () => {
        const atlas = await petService.atlas(petId);
        if (!atlas.ok || !atlas.data) return null;
        return decodeAtlas(
            atlas.data.dataBase64,
            atlas.data.file,
            spec.animations,
            spec.atlasLayout ?? null,
            spec.lookRows ?? null,
            /* 预览的显示高度：格子 208 → 104（整数倍，像素画清晰） */
            104,
        );
    })();
    cache.set(key, {promise});
    return promise;
}

/** 待机动画：优先叫 `idle` 的那个动画，没有就用第 0 个 */
function idleAnimation(spec: PetSpecDto): number {
    const index = spec.animations.findIndex((animation) => animation.name === 'idle');
    return index >= 0 ? index : 0;
}

export function PetPreview({spec, petId}: {spec: PetSpecDto; petId: string}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        let disposed = false;
        let timer: number | null = null;
        void (async () => {
            const decoded = await loadDecoded(spec, petId);
            if (disposed || !decoded) return;
            const canvas = canvasRef.current;
            const context = canvas?.getContext('2d');
            if (!canvas || !context) return;

            const animation = idleAnimation(spec);
            const frames = Math.max(1, spec.animations[animation]?.frames ?? 1);
            const frameMs = Math.max(60, spec.animations[animation]?.frameMs ?? 240);
            let frame = 0;
            const paint = () => {
                if (disposed) return;
                drawAtlasFrame(context, decoded, animation, frame, canvas.width, canvas.height);
                frame = (frame + 1) % frames;
            };
            paint();
            timer = window.setInterval(paint, frameMs);
        })();
        return () => {
            disposed = true;
            if (timer !== null) window.clearInterval(timer);
        };
    }, [petId, spec]);

    return (
        <canvas
            ref={canvasRef}
            className={styles.petPreview}
            width={96}
            height={104}
            aria-hidden="true"
            data-pet-preview={petId}
        />
    );
}

