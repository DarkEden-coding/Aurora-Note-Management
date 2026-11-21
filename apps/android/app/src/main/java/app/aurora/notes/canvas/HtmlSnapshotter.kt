// Practice cards and rich text are drawn by the web app's own code: an offscreen WebView loads the
// renderer page (assets/render, built from apps/web), renders one object, and is copied into a bitmap.
package app.aurora.notes.canvas

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import org.json.JSONObject
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

private const val MAX_PX = 2048
/** Bitmap pixels per world unit: sharp at 100% zoom on a 2x screen. */
private const val PIXELS_PER_UNIT = 2.0
private const val RENDER_TIMEOUT_MS = 5_000L

@SuppressLint("SetJavaScriptEnabled")
class HtmlSnapshotter(activity: Activity) {
    private val loaded = CompletableDeferred<Unit>()
    private val lock = Mutex()
    @Volatile private var pending: Pair<Int, CompletableDeferred<Unit>>? = null
    private var token = 0

    private val web = WebView(activity).apply {
        settings.javaScriptEnabled = true
        setBackgroundColor(Color.TRANSPARENT)
        addJavascriptInterface(object {
            @JavascriptInterface
            fun done(t: Int) { pending?.takeIf { it.first == t }?.second?.complete(Unit) }
        }, "AuroraRender")
        webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) { loaded.complete(Unit) }
        }
        loadUrl("file:///android_asset/render/index.html")
    }

    init {
        // Attached (so it lays out and runs frames) but placed first, under the opaque app content.
        (activity.window.decorView as ViewGroup).addView(web, 0, FrameLayout.LayoutParams(MAX_PX, MAX_PX))
    }

    /** Renders one object at its world size; null if the page could not draw it in time. */
    suspend fun render(kind: String, payload: JsonObject, width: Double, height: Double): Bitmap? = lock.withLock {
        if (width <= 0 || height <= 0) return null
        withTimeoutOrNull(RENDER_TIMEOUT_MS) { loaded.await() } ?: return null
        val pixelsPerUnit = min(PIXELS_PER_UNIT, MAX_PX / max(width, height))
        val zoom = pixelsPerUnit / web.resources.displayMetrics.density
        val done = CompletableDeferred<Unit>()
        val t = ++token
        pending = t to done
        web.evaluateJavascript("renderObject($t, ${JSONObject.quote(kind)}, $payload, $width, $height, $zoom)", null)
        withTimeoutOrNull(RENDER_TIMEOUT_MS) { done.await() } ?: return null
        val bitmap = Bitmap.createBitmap(ceil(width * pixelsPerUnit).toInt(), ceil(height * pixelsPerUnit).toInt(), Bitmap.Config.ARGB_8888)
        web.draw(Canvas(bitmap))
        bitmap
    }
}
