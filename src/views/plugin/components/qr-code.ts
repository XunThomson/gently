import qrcode from 'qrcode-generator';

/**
 * 二维码内容的 SVG data URL。
 *
 * 为什么在**前端**画：二维码要编码的是一串文字（插件给的登录 URL），画图是纯展示。
 * 让插件生成像素图意味着插件里要带一个 QR 编码器（QuickJS 沙箱里跑），把复杂度放错了地方。
 */
export function qrSvgDataUrl(content: string, cellSize = 4): string {
    const qr = qrcode(0, 'M');
    qr.addData(content);
    qr.make();
    const svg = qr.createSvgTag({cellSize, margin: 2});
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
