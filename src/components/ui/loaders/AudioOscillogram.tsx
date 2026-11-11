import {useEffect, useRef} from 'react';
import {audioEngine} from '../../../services/audio.service';

/**
 * 歌词页的音频律动（R139）。
 *
 * 来源是用户给的 `examples/test.html` 波形 demo，但做了三处**项目适配**：
 * 1. 不采集系统声音（`getDisplayMedia` 在 WebView 里不可用，也会把别的 App 的声音混进来），
 *    改成从**当前播放的媒体元素**取 AnalyserNode（见 `audio.service.ts::ensureAnalyser`）；
 * 2. 颜色不再写死蓝色：从主题 token（`--brand` / `--divider`）读，浅色/深色都跟着变；
 * 3. 它只是歌词页的**补充信息**，不是视觉中心——固定 36px 高、半透明、无边框，
 *    静音时是一条细直线，不抢歌词。
 *
 * 安全边界：分析器拿不到（AudioContext 没 running / 浏览器不支持）时只画直线，
 * **不强行接线**——那会把正在播放的声音改道到暂停的音频图里（宁可不炫，不能没声）。
 */

/** 时域采样点数：越大波形越密，但每帧开销也越大 */
const FFT_SIZE = 1024;
/** 平滑系数：越小越跟手，越大越柔和 */
const SMOOTHING = 0.78;
/** maxDev 小于此值 → 认为静音 → 画直线（0~127） */
const SILENT_TH = 3;
/** 显示增益：媒体响度通常比系统采集小，放大一点才看得出来 */
const GAIN = 1.6;

function resolveColors(): {wave: string; guide: string} {
    if (typeof window === 'undefined') return {wave: '#7c5cff', guide: 'rgba(120,120,130,.25)'};
    const style = getComputedStyle(document.documentElement);
    return {
        wave: style.getPropertyValue('--brand').trim() || '#7c5cff',
        guide: style.getPropertyValue('--divider').trim() || 'rgba(120,120,130,.25)',
    };
}

export interface AudioOscillogramProps {
    className?: string;
}

export function AudioOscillogram({className}: AudioOscillogramProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext('2d');
        if (!context) return;

        const reduceMotion =
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let width = 0;
        let height = 0;
        let analyser: AnalyserNode | null = null;
        let buffer: Uint8Array | null = null;
        let raf = 0;
        let disposed = false;
        let frame = 0;
        let colors = resolveColors();

        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            width = Math.max(1, Math.round(rect.width));
            height = Math.max(1, Math.round(rect.height));
            canvas.width = Math.max(1, Math.round(width * dpr));
            canvas.height = Math.max(1, Math.round(height * dpr));
            context.setTransform(dpr, 0, 0, dpr, 0, 0);
            if (!analyser) drawSilence();
        };

        const drawGuide = () => {
            context.beginPath();
            context.moveTo(0, height / 2);
            context.lineTo(width, height / 2);
            context.strokeStyle = colors.guide;
            context.lineWidth = 1;
            context.stroke();
        };

        const drawSilence = () => {
            context.clearRect(0, 0, width, height);
            drawGuide();
            context.beginPath();
            context.moveTo(0, height / 2);
            context.lineTo(width, height / 2);
            context.strokeStyle = colors.guide;
            context.lineWidth = 1.5;
            context.lineCap = 'round';
            context.stroke();
        };

        const drawWave = () => {
            if (!buffer) return;
            context.clearRect(0, 0, width, height);
            drawGuide();

            const amp = height / 2 - 4;
            const length = buffer.length;
            context.beginPath();
            for (let x = 0; x <= width; x += 1) {
                const index = Math.min(length - 1, Math.floor((x / width) * length));
                /* 128 是 Uint8 时域数据的中点；归一化到 -1~1 */
                const normalized = (buffer[index] - 128) / 128;
                let y = height / 2 + normalized * amp * GAIN;
                if (y < 2) y = 2;
                else if (y > height - 2) y = height - 2;
                if (x === 0) context.moveTo(x, y);
                else context.lineTo(x, y);
            }
            context.strokeStyle = colors.wave;
            context.lineWidth = 1.5;
            context.lineJoin = 'round';
            context.lineCap = 'round';
            context.globalAlpha = 0.75;
            context.stroke();
            context.globalAlpha = 1;
        };

        const loop = () => {
            if (disposed) return;
            raf = requestAnimationFrame(loop);
            if (!analyser || !buffer) return;
            frame += 1;
            /* 主题可能在运行中切换：每秒刷新一次颜色即可，不每帧 getComputedStyle */
            if (frame % 60 === 0) colors = resolveColors();
            analyser.getByteTimeDomainData(buffer);
            let maxDeviation = 0;
            for (let i = 0; i < buffer.length; i += 1) {
                const deviation = Math.abs(buffer[i] - 128);
                if (deviation > maxDeviation) maxDeviation = deviation;
            }
            if (maxDeviation < SILENT_TH) drawSilence();
            else drawWave();
        };

        const connect = async () => {
            if (disposed || analyser) return;
            const node = await audioEngine.ensureAnalyser();
            if (disposed || !node) return;
            analyser = node;
            analyser.fftSize = FFT_SIZE;
            analyser.smoothingTimeConstant = SMOOTHING;
            buffer = new Uint8Array(analyser.fftSize);
            resize();
            if (!reduceMotion) loop();
        };

        const observer =
            typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
        observer?.observe(canvas);
        resize();
        drawSilence();
        void connect();

        /* 分析器第一次可能因为 AudioContext 处于 suspended 而拿不到：
           用户下一次触摸（真实手势）再试一次，不轮询、不弹窗。 */
        const retryOnGesture = () => {
            void connect();
        };
        window.addEventListener('pointerdown', retryOnGesture, {passive: true});

        return () => {
            disposed = true;
            cancelAnimationFrame(raf);
            observer?.disconnect();
            window.removeEventListener('pointerdown', retryOnGesture);
        };
    }, []);

    return <canvas ref={canvasRef} className={className} aria-hidden="true"/>;
}

export default AudioOscillogram;
