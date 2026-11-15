/**
 * 长时间后台保活（R144）。
 *
 * 现象：把窗口最小化 / 切到后台放几分钟，回来时整页重载、播放与宠物位置被重置，
 * 严重时界面卡住。
 *
 * 根因方向：Chromium / WebView2 在窗口隐藏约 5 分钟后会 **freeze 甚至 discard**
 * 整个页面（后台节流策略）。Tauri 的 `backgroundThrottling` 配置在 Windows / Android
 * 上不生效；官方建议的绕过方式是持有一个**永不完成的 Web Lock**——只要页面还持有锁，
 * 浏览器就不能把它冻结/丢弃（否则等待同一把锁的页面会永远等不到）。
 *
 * 这里是纯前端、无副作用的保险：
 * - 不支持 Web Locks 的旧 WebView 直接跳过（不报错、不影响启动）；
 * - 锁名带应用前缀，避免和嵌入的网页壁纸 / 插件页面互相影响；
 * - 不轮询、不占 CPU：只是一个 pending Promise。
 */
const KEEPALIVE_LOCK = 'gently:background-keepalive';

export function installBackgroundKeepAlive(): void {
    if (typeof navigator === 'undefined') return;
    const locks = navigator.locks;
    if (!locks || typeof locks.request !== 'function') return;

    void locks
        .request(KEEPALIVE_LOCK, () => new Promise<void>(() => undefined))
        .catch(() => undefined);
}
