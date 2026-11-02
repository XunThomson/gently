package com.xun.gently

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder

/**
 * 播放保活的**前台服务** + **MediaSession**（P2-1 · R112，P2-2 · R115 补传输控制）。
 *
 * 为什么必须有它：真机实测（ANDROID-PLAN §7.4）表明，熄屏/切后台后系统会把 WebView 里的媒体
 * 挂起——先是音频停住、位置僵死，时间再长一点直接回收渲染进程（页面被整页重载、播放状态全丢）。
 * 进程本身没死，所以这是**重要性**问题而不是内存问题：把应用提到「前台服务」档次，
 * 系统才会把它当「正在放音的应用」，既不挂起也不回收。
 *
 * 职责边界（**服务不拥有播放状态**）：
 * - 它只显示「在放什么 / 是否在播」，并把用户的传输动作（通知栏、锁屏、耳机键）
 *   通过 [MediaActionBridge] 送回页面——改 store 的永远是前端；
 * - 播放位置不归它管（页面每 10 秒自己落盘，见 `utils/lastPlayback.ts`），
 *   所以 `PlaybackState` 只给「在播 / 暂停」，不假装自己知道进度。
 *
 * 注意 API 级别：本机是 API 29，但 `targetSdk = 36`，所以清单里同时声明
 * `FOREGROUND_SERVICE_MEDIA_PLAYBACK` 与 `foregroundServiceType="mediaPlayback"`
 * （API 34+ 缺了会直接抛 `SecurityException`）。
 */
class PlaybackService : Service() {

    private var session: MediaSession? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel(this)
        session = MediaSession(this, "gently-playback").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = dispatch(ACTION_TOGGLE)
                override fun onPause() = dispatch(ACTION_TOGGLE)
                override fun onSkipToNext() = dispatch(ACTION_NEXT)
                override fun onSkipToPrevious() = dispatch(ACTION_PREV)
            })
            isActive = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_TOGGLE, ACTION_NEXT, ACTION_PREV -> {
                /* 通知按钮：只把动作转给页面（页面会回推新的 playing/title，
                   我们再据此刷新通知与 MediaSession——一条单向链路，不循环） */
                dispatch(intent.action!!)
                return START_NOT_STICKY
            }
        }

        val title = intent?.getStringExtra(EXTRA_TITLE).orEmpty()
        val artist = intent?.getStringExtra(EXTRA_ARTIST).orEmpty()
        val line = intent?.getStringExtra(EXTRA_LINE).orEmpty()
        val playing = intent?.getBooleanExtra(EXTRA_PLAYING, true) ?: true

        applyState(title, artist, line, playing)
        // 必须尽快进入前台态：API 26+ 起 startForegroundService 后 5 秒内不调 startForeground 会崩
        startForeground(NOTIFICATION_ID, buildNotification(title, artist, line, playing))
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        session?.isActive = false
        session?.release()
        session = null
        super.onDestroy()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    /** 同步 MediaSession 的元数据与播放态（锁屏 / 蓝牙 / 车机读的是它） */
    private fun applyState(title: String, artist: String, line: String, playing: Boolean) {
        val current = session ?: return
        current.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title.ifBlank { getString(R.string.app_name) })
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                /* 通知栏歌词（P4）：副标题放当前这一句，锁屏上也能看到。
                   没有歌词时退回歌手，避免锁屏出现一条空白副标题。 */
                .putString(
                    MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE,
                    if (line.isNotBlank()) line else artist,
                )
                .build(),
        )
        current.setPlaybackState(
            PlaybackState.Builder()
                .setState(
                    if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    PlaybackState.PLAYBACK_POSITION_UNKNOWN,
                    1f,
                )
                .setActions(
                    PlaybackState.ACTION_PLAY or
                        PlaybackState.ACTION_PAUSE or
                        PlaybackState.ACTION_PLAY_PAUSE or
                        PlaybackState.ACTION_SKIP_TO_NEXT or
                        PlaybackState.ACTION_SKIP_TO_PREVIOUS,
                )
                .build(),
        )
    }

    private fun dispatch(action: String) {
        MediaActionBridge.dispatch(
            when (action) {
                ACTION_NEXT -> "next"
                ACTION_PREV -> "prev"
                else -> "toggle"
            },
        )
    }

    private fun buildNotification(
        title: String,
        artist: String,
        line: String,
        playing: Boolean,
    ): Notification {
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

        builder
            .setContentTitle(title.ifBlank { getString(R.string.app_name) })
            /* 通知栏歌词（P4）：第二行优先显示「正在唱的那一句」，没有歌词才退回歌手 */
            .setContentText(if (line.isNotBlank()) line else artist)
            // 用系统自带的媒体图标：不为一个通知新增资源文件
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(openApp)
            .setOngoing(playing)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(actionOf(ACTION_PREV, android.R.drawable.ic_media_previous, "上一首"))
            .addAction(
                if (playing) {
                    actionOf(ACTION_TOGGLE, android.R.drawable.ic_media_pause, "暂停")
                } else {
                    actionOf(ACTION_TOGGLE, android.R.drawable.ic_media_play, "播放")
                },
            )
            .addAction(actionOf(ACTION_NEXT, android.R.drawable.ic_media_next, "下一首"))

        /* MediaStyle 把通知接进 MediaSession：锁屏 / 蓝牙 / 车机的控制都走这一条 */
        val style = Notification.MediaStyle().setShowActionsInCompactView(0, 1, 2)
        session?.sessionToken?.let { style.setMediaSession(it) }
        builder.style = style
        return builder.build()
    }

    private fun actionOf(action: String, icon: Int, label: String): Notification.Action {
        val intent = Intent(this, PlaybackService::class.java).apply { this.action = action }
        val pending = PendingIntent.getService(
            this,
            action.hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Action.Builder(icon, label, pending).build()
    }

    companion object {
        const val ACTION_STOP = "com.xun.gently.playback.STOP"
        const val ACTION_TOGGLE = "com.xun.gently.playback.TOGGLE"
        const val ACTION_NEXT = "com.xun.gently.playback.NEXT"
        const val ACTION_PREV = "com.xun.gently.playback.PREV"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_PLAYING = "playing"
        /** 当前歌词行（P4 通知栏歌词，R116） */
        const val EXTRA_LINE = "line"

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
