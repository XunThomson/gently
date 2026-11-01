package com.xun.gently

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * 播放保活的**前台服务**（P2-1，R112）。
 *
 * 为什么必须有它：真机实测（ANDROID-PLAN §7.4）表明，熄屏/切后台后系统会把 WebView 里的媒体
 * 挂起——先是音频停住、位置僵死，时间再长一点直接回收渲染进程（页面被整页重载、播放状态全丢）。
 * 进程本身没死，所以这是**重要性**问题而不是内存问题：把应用提到「前台服务」档次，
 * 系统才会把它当「正在放音的应用」，既不挂起也不回收。
 *
 * 职责刻意做小（P2-2 才加 MediaSession 与传输控制）：
 * - 起一个带歌曲信息的常驻通知（点一下回到应用）；
 * - 让进程在后台保持前台服务级别；
 * - 停止播放时无条件退出（不常驻、不偷电）。
 *
 * 注意 API 级别：本机是 API 29，但 `targetSdk = 36`，所以清单里同时声明
 * `FOREGROUND_SERVICE_MEDIA_PLAYBACK` 与 `foregroundServiceType="mediaPlayback"`
 * （API 34+ 缺了会直接抛 `SecurityException`）。
 */
class PlaybackService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }

        val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty()
        val artist = intent?.getStringExtra(EXTRA_ARTIST).orEmpty()

        // 必须尽快进入前台态：API 26+ 起 startForegroundService 后 5 秒内不调 startForeground 会崩
        startForeground(NOTIFICATION_ID, buildNotification(title, artist))
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun buildNotification(title: String, artist: String): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                addCategory(Intent.CATEGORY_LAUNCHER)
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        return builder
            .setContentTitle(title.ifBlank { getString(R.string.app_name) })
            .setContentText(artist)
            // 用系统自带的媒体图标：不为一个通知新增资源文件（P2-2 换成自己的图标）
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build()
    }

    companion object {
        const val ACTION_STOP = "com.xun.gently.playback.STOP"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"

        private const val CHANNEL_ID = "gently-playback"
        private const val NOTIFICATION_ID = 1001

        /** 通知渠道只需建一次；重复创建是幂等的（同 id 会被忽略）。 */
        private fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return
            val channel = NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.app_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "正在播放"
                setShowBadge(false)
            }
            manager.createNotificationChannel(channel)
        }
    }
}
