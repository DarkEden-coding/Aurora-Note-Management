// Full-screen document scanner. It runs the web app's own scanner (camera viewfinder with live edge
// detection, corner review, perspective flattening) from the bundled assets/scan page in a WebView,
// and hands the finished JPEG back through the AuroraScan bridge.
package app.aurora.notes.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewAssetLoader

private const val SCAN_PAGE = "https://appassets.androidplatform.net/assets/scan/index.html"

/** Shows the scanner; [onScanned] gets the flattened JPEG's file name and bytes. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
internal fun ScanScreen(onScanned: (name: String, jpeg: ByteArray) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val deliver = rememberUpdatedState(onScanned)
    val dismiss = rememberUpdatedState(onClose)
    // The page's camera request waits here until the user answers the Android permission prompt.
    val pendingCamera = remember { arrayOfNulls<PermissionRequest>(1) }
    val pendingFile = remember { arrayOfNulls<ValueCallback<Array<Uri>>>(1) }

    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingCamera[0] ?: return@rememberLauncherForActivityResult
        pendingCamera[0] = null
        if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else request.deny()
    }
    // The viewfinder's "choose a photo" button opens the system picker.
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        pendingFile[0]?.onReceiveValue(uri?.let { arrayOf(it) } ?: emptyArray())
        pendingFile[0] = null
    }

    Dialog(onClose, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val assets = remember { WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build() }
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.mediaPlaybackRequiresUserGesture = false
                    setBackgroundColor(android.graphics.Color.BLACK)
                    addJavascriptInterface(object {
                        @JavascriptInterface
                        fun scanned(name: String, base64: String) {
                            val bytes = Base64.decode(base64, Base64.DEFAULT)
                            post { deliver.value(name, bytes) }
                        }

                        @JavascriptInterface
                        fun close() { post { dismiss.value() } }
                    }, "AuroraScan")
                    webViewClient = object : WebViewClient() {
                        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                            assets.shouldInterceptRequest(request.url)
                    }
                    webChromeClient = object : WebChromeClient() {
                        override fun onPermissionRequest(request: PermissionRequest) {
                            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE !in request.resources) return request.deny()
                            if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                                request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                            } else {
                                pendingCamera[0] = request
                                cameraPermission.launch(Manifest.permission.CAMERA)
                            }
                        }

                        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                            pendingFile[0]?.onReceiveValue(null)
                            pendingFile[0] = callback
                            pickImage.launch("image/*")
                            return true
                        }
                    }
                    loadUrl(SCAN_PAGE)
                }
            },
            onRelease = { it.destroy() },
        )
        DisposableEffect(Unit) {
            onDispose { pendingFile[0]?.onReceiveValue(null); pendingCamera[0]?.deny() }
        }
    }
}
