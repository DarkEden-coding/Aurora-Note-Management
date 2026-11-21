// Pictures on the canvas: uploaded images and pages of imported PDFs (/api/files/<id>).
// Files are downloaded once and kept on disk for offline use; decoded bitmaps live in a
// size-bounded memory cache. Anything missing loads in the background and triggers a redraw.
package app.aurora.notes.canvas

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.LruCache
import app.aurora.notes.data.AuroraApi
import app.aurora.notes.data.CanvasObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt

private const val MAX_EDGE_PX = 2048
/** PDF pages render at this many pixels per world unit (sharp at 100% on a 2x screen). */
private const val PDF_PIXELS_PER_UNIT = 2.0
private const val RETRY_AFTER_MS = 30_000L

class ImageStore(context: Context, private val api: AuroraApi) {
    private val dir = File(context.filesDir, "images").apply { mkdirs() }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    /** PdfRenderer is single-threaded; one worker keeps the last opened document. */
    private val pdfWorker = Dispatchers.IO.limitedParallelism(1)
    private var openPdf: Pair<String, PdfRenderer>? = null
    private val memory = object : LruCache<String, Bitmap>(128 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }
    private val loading = HashSet<String>()
    private val failedAt = HashMap<String, Long>()

    /** Draws practice cards and rich text; set once the activity window exists. */
    var snapshotter: HtmlSnapshotter? = null

    /** Called on the main thread when a picture finishes loading. */
    var onLoaded: (() -> Unit)? = null

    /** An uploaded image, or null while it loads. */
    fun image(fileId: String): Bitmap? = cached(fileId) {
        withContext(Dispatchers.IO) { decode(download(fileId)) }
    }

    /** Page [pageNumber] (1-based) of an uploaded PDF, rendered for [widthUnits] world units; null while it loads. */
    fun pdfPage(fileId: String, pageNumber: Int, widthUnits: Double): Bitmap? = cached("$fileId#$pageNumber") {
        val file = withContext(Dispatchers.IO) { download(fileId) }
        withContext(pdfWorker) { renderPage(fileId, file, pageNumber, widthUnits) }
    }

    /** A practice card or rich-text block rendered by the web renderer, or null while it renders. */
    fun html(o: CanvasObject): Bitmap? {
        val renderer = snapshotter ?: return null
        val key = "html:${o.id}:${o.payload.hashCode()}:${o.bounds.width}x${o.bounds.height}"
        return cached(key) { renderer.render(o.kind, o.payload, o.bounds.width, o.bounds.height) }
    }

    private fun cached(key: String, load: suspend () -> Bitmap?): Bitmap? {
        memory.get(key)?.let { return it }
        val failed = failedAt[key]
        if (failed != null && SystemClock.uptimeMillis() - failed < RETRY_AFTER_MS) return null
        if (!loading.add(key)) return null
        scope.launch {
            val bitmap = runCatching { load() }.getOrNull()
            loading.remove(key)
            if (bitmap == null) { failedAt[key] = SystemClock.uptimeMillis(); return@launch }
            failedAt.remove(key)
            memory.put(key, bitmap)
            onLoaded?.invoke()
        }
        return null
    }

    private suspend fun download(fileId: String): File {
        val file = File(dir, fileId.replace(Regex("[^A-Za-z0-9._-]"), "_"))
        if (!file.exists()) {
            val temp = File(dir, file.name + ".part")
            temp.writeBytes(api.fileBytes(fileId))
            temp.renameTo(file)
        }
        return file
    }

    private fun decode(file: File): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_EDGE_PX) sample *= 2
        return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    private fun renderPage(fileId: String, file: File, pageNumber: Int, widthUnits: Double): Bitmap? {
        val renderer = openPdf?.takeIf { it.first == fileId }?.second ?: run {
            openPdf?.second?.close()
            PdfRenderer(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)).also { openPdf = fileId to it }
        }
        if (pageNumber !in 1..renderer.pageCount) return null
        renderer.openPage(pageNumber - 1).use { page ->
            val width = (widthUnits * PDF_PIXELS_PER_UNIT).roundToInt().coerceIn(1, MAX_EDGE_PX)
            val height = (width.toDouble() * page.height / page.width).roundToInt().coerceAtLeast(1)
            val argb = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            argb.eraseColor(Color.WHITE)
            page.render(argb, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            // Opaque pages keep at half the memory, so a whole screen of pages fits in the cache.
            return argb.copy(Bitmap.Config.RGB_565, false).also { argb.recycle() }
        }
    }
}
