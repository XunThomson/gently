package com.xun.gently

import android.util.Log
import android.webkit.WebView
import java.lang.ref.WeakReference

/**
 * 原生 → 页面的动作通道（P2-2 · R115）。
 *
 * 通知栏 / 锁屏 / 耳机键的播放控制在**原生侧**收到，但播放状态的唯一权威是页面里的 store
 * （前端 `useAudioEngine` 装的 `window.__gentlyMediaAction`）。所以这里只做一件事：
 * 把动作名用 `evaluateJavascript` 送进页面，由前端去改 store——原生不自己改状态。
 *
 * 为什么用 `evaluateJavascript` 而不是 Tauri 的插件事件：移动插件的事件注册要走
 * Rust 的 `Channel`（只能由 JS 发起一次订阅），而「用户按了通知栏按钮」是**原生主动发起**的。
 * 页面本来就活着（前台服务保证），注入一行调用是最短、最不容易错的一条路。
 */
internal object MediaActionBridge {
    private const val TAG = "GentlyMedia"
    /** 全局函数名：与前端 `services/playbackBanner.service.ts` 约定一致 */
    private const val HANDLER = "__gentlyMediaAction"

    private var webView = WeakReference<WebView>(null)

    fun attach(view: WebView) {
        webView = WeakReference(view)
    }

    fun detach() {
        webView = WeakReference(null)
    }

    /**
     * 派发一个动作给页面。
     *
     * @param action `toggle` / `next` / `prev`（与前端约定）
     */
    fun dispatch(action: String) {
        val view = webView.get()
        if (view == null) {
            Log.w(TAG, "页面已经不可用，丢弃动作 $action")
            return
        }
        val script = """
            (function () {
              var handler = window.$HANDLER;
              if (typeof handler === 'function') { handler('$action'); return 'ok'; }
              return 'missing';
            })();
        """.trimIndent()
        view.post {
            try {
                view.evaluateJavascript(script, null)
            } catch (err: Exception) {
                Log.w(TAG, "派发动作失败：$action", err)
            }
        }
    }
}
