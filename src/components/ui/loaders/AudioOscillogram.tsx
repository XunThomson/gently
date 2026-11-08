export function AudioOscillogram() {
    /* ================= 配置 ================= */
    const FFT_SIZE = 2048;      // 时域采样点数：越大波形越密
    const SMOOTHING = 0.65;      // 平滑系数
    const SILENT_TH = 3;         // maxDev 小于此值 → 静音 → 画直线
    const GAIN = 1.8;       // 显示增益（系统音频通常幅度偏小）
    const COLOR_LINE = '#4b5563'; // 静音直线颜色
    const COLOR_GUIDE = '#191922'; // 中线参考颜色
    const COLOR_WAVE = '#3b82f6'; // 波形颜色

    /* ================= 状态 ================= */
    let W = 0, H = 0;
    let audioCtx = null, analyser = null, buf = null, source = null;
    let stream = null;
    let running = false;
    let rafId = 0;

    const resize = () =>{
        const dpr  = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        W = Math.max(1, rect.width);
        H = Math.max(1, rect.height);
        canvas.width  = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (!running) drawSilence();
    }


}