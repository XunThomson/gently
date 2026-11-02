package com.xun.gently

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import kotlin.concurrent.thread

/**
 * 导入音频（P3，R114）：用系统的 **SAF**（`ACTION_OPEN_DOCUMENT`）选文件，
 * 拷进应用私有目录 `<filesDir>/music`，再由前端触发 `library.local.scan` 入库。
 *
 * 为什么必须是 SAF：安卓上没有「把路径粘贴进来」这条路——普通用户拿不到
 * `/storage/emulated/0/...` 这种绝对路径，之前只能靠 adb push 往应用目录塞文件。
 * SAF 还**不需要任何存储权限**：用户选了什么，系统就临时授权读那一个 URI。
 *
 * 为什么是「拷一份」而不是「把 URI 记进库」：
 * - 曲库与播放都按**文件路径**工作（`library.local.scan` / 本地代理按路径读盘），
 *   content:// URI 进来会牵动核心、代理、封面三条链路；
 * - URI 的授权是临时的，用户清理「最近打开」或卸载来源应用后就失效；
 * - 拷贝进应用私有目录后，原文件删掉也不影响曲库（用户意图是「收进我的音乐」）。
 */
@TauriPlugin
class ImportPlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * 导入进度（R136）：拷几个大文件可能几十秒，界面要有「到哪了」。
     *
     * 为什么是**状态 + 轮询**而不是事件推送：Kotlin → Rust 没有现成的回调通道
     * （Tauri 的移动插件只有 Rust → Kotlin 方向），而 Rust → Kotlin 是现成的
     * （`run_mobile_plugin_async`）。所以让 Kotlin 只维护一份快照，Rust 侧用
     * `importProgress` 命令读走，前端在导入期间每 250ms 问一次——一轮导入也就几十次调用。
     */
    data class Progress(
        val active: Boolean,
        val fileName: String,
        val fileIndex: Int,
        val fileCount: Int,
        val bytesDone: Long,
        val bytesTotal: Long,
        val imported: Int,
        val failed: Int,
        val skipped: Int,
    )

    @Command
    fun pickAudio(invoke: Invoke) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            /* 不能只按「音频类型」过滤：系统的 MIME 库不认 `.m4s` / `.m4b` 这类封装，
                它们会被**灰掉、根本选不了**（R118 真机实测：同一个文件改成 `.mp3`
                就能选，`.m4s` 是灰的）。所以放开到「音频 + 未知类型」，
                选完再由 `isAudioName` 按扩展名筛——认得的扩展名以核心为准
                （`core/src/local_library.rs::AUDIO_EXTENSIONS`）。 */
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("audio/*", "application/octet-stream"))
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        try {
            startActivityForResult(invoke, intent, "onPickAudio")
        } catch (err: Exception) {
            // 有些机型没有可处理 ACTION_OPEN_DOCUMENT 的应用：如实回错，不要假装「用户取消了」
            invoke.reject("打不开系统的文件选择器：${err.message}", err)
        }
    }

    /**
     * 导入用的落点目录（`<filesDir>/music`）。
     *
     * 为什么要问原生：界面上要能列出「哪些曲目是导入进来的副本」，并让用户一键清理。
     * 判断依据是**路径前缀**，而这个目录只有原生知道（`filesDir` 随包名/用户变化，
     * 前端不该猜）。同一个安装里它是稳定的，前端可以缓存。
     */
    @Command
    fun importedDir(invoke: Invoke) {
        val dir = File(activity.filesDir, "music").apply { mkdirs() }
        invoke.resolve(JSObject().apply { put("dir", dir.absolutePath) })
    }

    /**
     * 当前这次导入到哪了（R136）：没有导入在进行时 `active = false`。
     *
     * 字段名与 Rust 的 `ImportProgress`（camelCase）一一对应，前端只做展示。
     */
    @Command
    fun importProgress(invoke: Invoke) {
        val state = snapshot()
        invoke.resolve(JSObject().apply {
            put("active", state.active)
            put("fileName", state.fileName)
            put("fileIndex", state.fileIndex)
            put("fileCount", state.fileCount)
            put("bytesDone", state.bytesDone)
            put("bytesTotal", state.bytesTotal)
            put("imported", state.imported)
            put("failed", state.failed)
            put("skipped", state.skipped)
        })
    }

    /** 选择器返回：拷文件可能很慢，**放到后台线程**，拷完再回调（不卡 UI）。 */
    @ActivityCallback
    fun onPickAudio(invoke: Invoke, result: ActivityResult) {
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            // 取消也要把进度收掉：否则界面上会留一条「上次导入到 62%」的假进度
            setProgress(Progress(false, "", 0, 0, 0, 0, 0, 0, 0))
            invoke.resolve(JSObject().apply {
                put("imported", 0)
                put("failed", 0)
                put("skipped", 0)
                put("cancelled", true)
                put("dir", "")
            })
            return
        }

        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index)?.uri?.let { uris.add(it) }
            }
        }
        data.data?.let { single -> if (uris.isEmpty()) uris.add(single) }

        thread(name = "gently-import") {
            val dir = File(activity.filesDir, "music").apply { mkdirs() }
            var imported = 0
            var failed = 0
            var skipped = 0
            /* 先算一遍总字节数：进度条要「这个文件拷到哪了」，只有文件数不够用
               （用户选一个 200 MB 的音频时，文件数一直是 1/1）。读不到大小的按 0 算。 */
            val sizes = uris.map { sizeOf(it) }
            val totalBytes = sizes.sum()
            setProgress(
                Progress(
                    active = uris.isNotEmpty(),
                    fileName = "",
                    fileIndex = 0,
                    fileCount = uris.size,
                    bytesDone = 0,
                    bytesTotal = totalBytes,
                    imported = 0,
                    failed = 0,
                    skipped = 0,
                ),
            )
            for ((position, uri) in uris.withIndex()) {
                val name = displayName(uri) ?: "imported-${System.currentTimeMillis()}.audio"
                /* 放开 MIME 之后用户可能选到图片/文档：按核心认得的扩展名筛掉，
                    并且**如实告诉用户跳过了几个**（静默丢弃会让人以为导入失败） */
                if (!isAudioName(name)) {
                    skipped += 1
                    updateProgress {
                        it.copy(
                            skipped = skipped,
                            fileIndex = position + 1,
                            // 跳过 = 这个文件立刻「完成」：否则进度条会停在那儿不动
                            bytesDone = it.bytesDone + sizes[position],
                        )
                    }
                    continue
                }
                val target = uniqueFile(dir, name)
                updateProgress { it.copy(fileName = name, fileIndex = position + 1) }

                var copied = 0L
                val ok = copyTo(uri, target) { chunk ->
                    copied += chunk
                    updateProgress { it.copy(bytesDone = it.bytesDone + chunk) }
                }
                if (ok) imported += 1 else failed += 1
                /* 读到的字节比声明的小（拷一半失败 / 上游截断）时把差额补上：
                   总进度只增不减，用户才不会看到「卡在 62%」 */
                val gap = sizes[position] - copied
                updateProgress {
                    it.copy(
                        imported = imported,
                        failed = failed,
                        bytesDone = if (gap > 0) it.bytesDone + gap else it.bytesDone,
                    )
                }
            }
            updateProgress {
                it.copy(active = false, imported = imported, failed = failed, skipped = skipped)
            }
            invoke.resolve(JSObject().apply {
                put("imported", imported)
                put("failed", failed)
                put("skipped", skipped)
                put("cancelled", false)
                put("dir", dir.absolutePath)
            })
        }
    }

    /**
     * 认不认得这个扩展名。
     *
     * 与核心保持**同一份名单**（`core/src/local_library.rs::AUDIO_EXTENSIONS`，12 个）：
     * 那边多认一种，这边就该跟着加——否则用户在手机上选得了，拷进来却被这里丢掉。
     */
    private fun isAudioName(name: String): Boolean {
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return false
        return name.substring(dot + 1).lowercase() in AUDIO_EXTENSIONS
    }

    /** SAF 里的显示名（含扩展名）；读不到就返回 null，由调用方兜一个名字 */    private fun displayName(uri: Uri): String? = try {
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (index >= 0) cursor.getString(index) else null
                } else {
                    null
                }
            }
    } catch (err: Exception) {
        null
    }

    /** 同名文件不覆盖：`a.mp3` → `a-1.mp3`（用户可能想留两份不同版本） */
    private fun uniqueFile(dir: File, name: String): File {
        val safe = name.replace('/', '_').replace('\\', '_').trim().ifEmpty { "imported.audio" }
        val dot = safe.lastIndexOf('.')
        val base = if (dot > 0) safe.substring(0, dot) else safe
        val ext = if (dot > 0) safe.substring(dot) else ""
        var candidate = File(dir, safe)
        var index = 1
        while (candidate.exists()) {
            candidate = File(dir, "$base-$index$ext")
            index += 1
        }
        return candidate
    }

    /**
     * 拷一个文件；每读一块就回调一次已拷字节数（进度用）。
     *
     * 不用 `copyTo` 是因为它不给中间进度：用户选一个 200 MB 的文件时，
     * 界面上会长时间停在「导入中…」，看起来像卡死。
     */
    private fun copyTo(uri: Uri, target: File, onChunk: (Long) -> Unit): Boolean = try {
        activity.contentResolver.openInputStream(uri).use { input ->
            if (input == null) return false
            target.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    output.write(buffer, 0, read)
                    onChunk(read.toLong())
                }
            }
        }
        target.length() > 0
    } catch (err: Exception) {
        // 单个文件失败不影响其它文件：调用方只关心「导入了几首 / 失败几首」
        target.delete()
        false
    }

    /** SAF 里声明的大小（字节）；读不到就是 0（进度条按「未知总量」显示）。 */
    private fun sizeOf(uri: Uri): Long = try {
        activity.contentResolver
            .query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (index >= 0 && !cursor.isNull(index)) cursor.getLong(index) else 0L
                } else {
                    0L
                }
            } ?: 0L
    } catch (err: Exception) {
        0L
    }

    companion object {
        /** 当前这次导入的快照（后台线程写、主线程读，一律经 `stateLock`）。 */
        private val stateLock = Any()
        private var state = Progress(false, "", 0, 0, 0, 0, 0, 0, 0)

        private fun snapshot(): Progress = synchronized(stateLock) { state }

        private fun setProgress(next: Progress) {
            synchronized(stateLock) { state = next }
        }

        private fun updateProgress(block: (Progress) -> Progress) {
            synchronized(stateLock) { state = block(state) }
        }

        /**
         * 与核心的 `AUDIO_EXTENSIONS` 一一对应（`core/src/local_library.rs`）。
         *
         * 只列这个构建真能解码的：`wma` / `ape` / `aiff` 等 symphonia 没开对应 feature，
         * 列进来只会让「导入成功但播不了」。
         */
        private val AUDIO_EXTENSIONS = setOf(
            "mp3", "flac", "m4a", "m4b", "m4r", "m4s", "mp4", "aac", "ogg", "oga", "opus", "wav",
        )
    }
}
