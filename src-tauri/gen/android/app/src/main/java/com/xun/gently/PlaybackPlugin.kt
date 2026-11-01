package com.xun.gently

import android.app.Activity
import android.content.Intent
import android.os.Build
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
}

/**
 * 播放通知 / 前台服务的桥（P2-1，R112）。
 *
 * 前端（`services/playbackBanner.service.ts`）→ Tauri 命令 `playback_banner`
 * → `run_mobile_plugin("update", {active,title,artist})` → 这里 → [PlaybackService]。
 *
 * 只做「起/停」两件事，所有播放状态仍以前端 store 为唯一权威：
 * 服务不读播放位置、也不自己计时（P2-2 的 MediaSession 同样只做输出层）。
 */
@TauriPlugin
class PlaybackPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun update(invoke: Invoke) {
        val args = invoke.parseArgs(PlaybackBannerArgs::class.java)
        val intent = Intent(activity, PlaybackService::class.java).apply {
            putExtra(PlaybackService.EXTRA_TITLE, args.title)
            putExtra(PlaybackService.EXTRA_ARTIST, args.artist)
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
