// Images on the canvas (/api/files/<id>): downloaded once, kept on disk for offline use,
// and decoded into a size-bounded memory cache. Missing images load in the background.
package app.aurora.notes.canvas

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import android.util.LruCache
import app.aurora.notes.data.AuroraApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

private const val MAX_EDGE_PX = 2048
private const val RETRY_AFTER_MS = 30_000L

class ImageStore(context: Context, private val api: AuroraApi) {
    private val dir = File(context.filesDir, "images").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val memory = object : LruCache<String, Bitmap>(96 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }
    private val loading = HashSet<String>()
    private val failedAt = HashMap<String, Long>()

    /** Called on the main thread when an image finishes loading. */
    var onLoaded: (() -> Unit)? = null

    /** The decoded image, or null while it loads (a load starts on first request). */
    fun get(fileId: String): Bitmap? {
        memory.get(fileId)?.let { return it }
        val failed = failedAt[fileId]
        if (failed != null && SystemClock.uptimeMillis() - failed < RETRY_AFTER_MS) return null
        if (!loading.add(fileId)) return null
        scope.launch {
            val bitmap = runCatching { withContext(Dispatchers.IO) { load(fileId) } }.getOrNull()
            loading.remove(fileId)
            if (bitmap == null) { failedAt[fileId] = SystemClock.uptimeMillis(); return@launch }
            failedAt.remove(fileId)
            memory.put(fileId, bitmap)
            onLoaded?.invoke()
        }
        return null
    }

    private suspend fun load(fileId: String): Bitmap? {
        val file = File(dir, fileId.replace(Regex("[^A-Za-z0-9._-]"), "_"))
        if (!file.exists()) {
            val temp = File(dir, file.name + ".part")
            temp.writeBytes(api.fileBytes(fileId))
            temp.renameTo(file)
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_EDGE_PX) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }
}
