package com.xun.gently

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.webkit.WebView
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/** `playback_banner` 的参数（Rust 用 `run_mobile_plugin("update", …)` 传过来）。 */
@InvokeArg
class PlaybackBannerArgs {
    var active: Boolean = false
    var title: String = ""
    var artist: String = ""
    /** 是否正在播放（只有它决定通知上的按钮是「播放」还是「暂停」） */
    var playing: Boolean = false
}

/**
 * 播放通知 / 前台服务 / MediaSession 的桥（P2-1 R112，P2-2 R115）。
 *
 * 前端（`services/playbackBanner.service.ts`）→ Tauri 命令 `playback_banner`
 * → `run_mobile_plugin("update", {active,title,artist,playing})` → 这里 → [PlaybackService]。
 *
 * 两个方向：
 * - **页面 → 原生**：`update` 把「在放什么 / 在不在播」推过来，服务据此刷新通知与 MediaSession；
 * - **原生 → 页面**：`load()` 时把 WebView 交给 [MediaActionBridge]；用户点通知栏 / 锁屏 /
 *   耳机键的按钮时，服务把动作（toggle/next/prev）送回页面，由前端改 store。
 *   服务因此**不拥有播放状态**，只做输出与转发。
 */
@TauriPlugin
class PlaybackPlugin(private val activity: Activity) : Plugin(activity) {

    override fun load(webView: WebView) {
        MediaActionBridge.attach(webView)
    }

    override fun onDestroy() {
        MediaActionBridge.detach()
    }

    @Command
    fun update(invoke: Invoke) {
        val args = invoke.parseArgs(PlaybackBannerArgs::class.java)
        val intent = Intent(activity, PlaybackService::class.java).apply {
            putExtra(PlaybackService.EXTRA_TITLE, args.title)
            putExtra(PlaybackService.EXTRA_ARTIST, args.artist)
            putExtra(PlaybackService.EXTRA_PLAYING, args.playing)
        }

        try {
            if (args.active) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ContextCompat.startForegroundService(activity, intent)
                } else {
                    activity.startService(intent)
                }
            } else {
                activity.stopService(Intent(activity, PlaybackService::class.java))
            }
            invoke.resolve()
        } catch (err: Exception) {
            // 起不来就如实回错：前端只会打一条 warn，不影响播放本身（继续靠在 WebView 里放）
            invoke.reject("播放通知启动失败：${err.message}", err)
        }
    }
}
