package com.xun.gently

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

/**
 * 主 Activity（R139 加固）。
 *
 * 背景：用户报「退后台 / 选文件 / 亮屏回来会白屏重载」。已定位到**装的是 dev 包**
 * （页面从 Vite dev server 拉模块，reload 后 dev server 不在就白屏）；除此之外这里做三件
 * 生产包也该做的事：
 *
 * 1. **不主动 reload**：`onResume` 只发一个页面事件。音频恢复走页面已有的
 *    `visibilitychange`（那里有超时、重载、重新解析一整套保护），Activity 再 reload 一次
 *    只会把状态全冲掉；
 * 2. **提高渲染进程优先级**：锁屏/后台时 WebView 渲染进程更容易被系统回收；
 *    `RENDERER_PRIORITY_IMPORTANT` 降低「回来时整页重载」的概率（API 26+）；
 * 3. **背景色跟主题**：万一真的要重建，闪的是主题底色而不是白块。
 *
 * 注意：`onWebViewCreate` 是 Wry 留给宿主的钩子，WebView 由生成的 `WryActivity` 创建，
 * 这里只做「拿到之后」的加固，不接管创建流程。
 */
class MainActivity : TauriActivity() {
    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }

    override fun onWebViewCreate(webView: WebView) {
        this.webView = webView
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        }
        /* 主题的窗口底色（启动屏同色）；之后 WebView 自己会覆盖成页面内容 */
        val typed = obtainStyledAttributes(intArrayOf(android.R.attr.colorBackground))
        val background = typed.getColor(0, Color.WHITE)
        typed.recycle()
        webView.setBackgroundColor(background)
    }

    override fun onResume() {
        super.onResume()
        /* 只通知，不 reload：页面的 visibilitychange 会走它自己的恢复/防抖逻辑 */
        webView?.post {
            webView?.evaluateJavascript(
                "window.dispatchEvent(new Event('gently:app:resume'))",
                null,
            )
        }
    }

    override fun onDestroy() {
        webView = null
        super.onDestroy()
    }
}
