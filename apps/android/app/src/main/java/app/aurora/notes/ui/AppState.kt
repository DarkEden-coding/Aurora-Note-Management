// App-level state: the library tree, the open note, and the bridge between the canvas and sync.
package app.aurora.notes.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.aurora.notes.canvas.CanvasDocument
import app.aurora.notes.canvas.CanvasView
import app.aurora.notes.canvas.DrawingStyle
import app.aurora.notes.data.HighlighterStyle
import app.aurora.notes.canvas.hasImportedPdf
import app.aurora.notes.data.Account
import app.aurora.notes.data.AuroraApi
import app.aurora.notes.data.LibraryNote
import app.aurora.notes.data.LibraryTree
import app.aurora.notes.data.LocalStore
import app.aurora.notes.data.Settings
import app.aurora.notes.data.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

class AppState(context: Context) {
    val settings = Settings(context)
    private val store = LocalStore(context)
    val api = AuroraApi(settings)
    val sync = SyncEngine(api, store, settings)
    private val images = app.aurora.notes.canvas.ImageStore(context, api)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    /** The open note's guided-practice session, shown in the practice bar. */
    val practice = PracticeState(api, sync, scope)

    var library by mutableStateOf(LibraryTree())
        private set
    var account by mutableStateOf<Account?>(null)
        private set
    var error by mutableStateOf<String?>(null)
    var openNoteId by mutableStateOf<String?>(null)
        private set
    var pageCount by mutableStateOf(1)
        private set
    var canUndo by mutableStateOf(false)
        private set
    var canRedo by mutableStateOf(false)
        private set
    var selectionCount by mutableStateOf(0)
        private set
    /** Pen color and shape defaults; the stroke color starts as the first palette color. */
    var drawingStyle by mutableStateOf<DrawingStyle?>(null)
    private var highlighterState by mutableStateOf(settings.highlighter)
    var highlighter: HighlighterStyle
        get() = highlighterState
        set(value) { highlighterState = value; settings.highlighter = value }
    var zoom by mutableStateOf(1.0)
        private set
    var currentPage by mutableStateOf(0)
        private set
    var importedPdf by mutableStateOf(false)
        private set
    /** Guided practice notes carry practice cards; their Add page button waits for the end of the note. */
    var hasPracticeCards by mutableStateOf(false)
        private set
    var lastPageBottomVisible by mutableStateOf(false)
        private set
    var canPaste by mutableStateOf(false)
        private set
    /** Bumped whenever floating canvas chrome (the selection bar) must be repositioned. */
    var chromeTick by mutableStateOf(0)
        private set
    private var lockXState by mutableStateOf(settings.lockX)
    var lockX: Boolean
        get() = lockXState
        set(value) { lockXState = value; settings.lockX = value; canvas?.lockX = value }

    val openNote: LibraryNote? get() = library.notes.firstOrNull { it.id == openNoteId }

    private var canvas: CanvasView? = null
    private var cameraSave: Job? = null
    private var openJob: Job? = null

    init {
        scope.launch { sync.remoteChanges.collect { change ->
            val view = canvas ?: return@collect
            val doc = view.document ?: return@collect
            if (change.noteId == doc.noteId) doc.applyRemote(change.objects, change.deletedIds, view.protectedIds(), change.localAcknowledgement)
        } }
        // The server appends pages (a new practice question) and announces it with these broadcasts.
        scope.launch { sync.libraryChanged.collect { refreshLibrary(); refreshPageCount() } }
        scope.launch { sync.practiceChanged.collect { noteId ->
            if (noteId != openNoteId) return@collect
            practice.load(noteId)
            refreshPageCount()
        } }
        // Broadcasts sent while the socket was down are lost; catch up when it reconnects.
        scope.launch { sync.status.map { it.connected }.distinctUntilChanged().collect { connected ->
            val noteId = openNoteId
            if (connected && noteId != null) { practice.load(noteId); refreshPageCount() }
        } }
        scope.launch {
            store.readLibrary()?.let { library = it }
            refreshLibrary()
            settings.lastNoteId?.let { id -> if (library.notes.any { it.id == id && !it.trashed }) open(id) }
        }
    }

    fun attach(view: CanvasView) {
        canvas = view
        view.lockX = lockX
        if (images.snapshotter == null) view.context.activity()?.let { images.snapshotter = app.aurora.notes.canvas.HtmlSnapshotter(it) }
        view.images = images
        view.onSelectionChanged = { selectionCount = it; refreshChrome() }
        view.onChromeChanged = { refreshChrome() }
        view.onDocumentChanged = { refreshHistory(); refreshPageChrome(view) }
        view.onCameraChanged = { camera ->
            zoom = camera.zoom
            currentPage = view.currentPageIndex()
            lastPageBottomVisible = view.lastPageBottomVisible()
            val noteId = view.document?.noteId
            cameraSave?.cancel()
            if (noteId != null) cameraSave = scope.launch {
                delay(300)
                settings.saveCamera(noteId, camera)
            }
        }
        openNoteId?.let { open(it) }
    }

    /** Saves the camera immediately, e.g. when the app is backgrounded. */
    fun flushCamera() {
        val view = canvas ?: return
        val noteId = view.document?.noteId ?: return
        cameraSave?.cancel()
        settings.saveCamera(noteId, view.camera)
    }

    fun refreshChrome() {
        chromeTick++
        canPaste = canvas?.canPaste == true
    }

    /** Re-reads what the Add page button depends on after the note, its objects or its page count change. */
    private fun refreshPageChrome(view: CanvasView) {
        hasPracticeCards = view.document?.all?.any { it.kind == "practice-card" } == true
        lastPageBottomVisible = view.lastPageBottomVisible()
        currentPage = view.currentPageIndex()
    }

    private fun refreshHistory() {
        val doc = canvas?.document
        canUndo = doc?.canUndo == true
        canRedo = doc?.canRedo == true
    }

    /** Re-reads the open paged note's page count, which the server changes when it appends pages. */
    private suspend fun refreshPageCount() {
        val noteId = openNoteId ?: return
        val view = canvas ?: return
        if (openNote?.canvasMode != "paged" || view.document?.noteId != noteId) return
        val count = runCatching { api.pageCount(noteId) }.getOrNull() ?: return
        if (openNoteId == noteId && view.document?.noteId == noteId) applyPageCount(view, noteId, count)
    }

    private fun applyPageCount(view: CanvasView, noteId: String, count: Int) {
        settings.savePageCount(noteId, count)
        if (count == pageCount) return
        pageCount = count
        view.setPageCount(count)
        refreshPageChrome(view)
    }

    suspend fun refreshLibrary() {
        try {
            val tree = api.library()
            library = tree
            if (account == null) account = api.account()
            error = null
        } catch (e: Exception) {
            error = "Offline: ${e.message ?: "server unreachable"}"
        }
    }

    fun open(noteId: String) {
        flushCamera()
        openNoteId = noteId
        settings.lastNoteId = noteId
        practice.load(noteId)
        val note = library.notes.firstOrNull { it.id == noteId } ?: return
        val view = canvas ?: return
        openJob?.cancel()
        openJob = scope.launch {
            val ownerId = account?.ownerId ?: runCatching { api.account().also { account = it } }.getOrNull()?.ownerId ?: return@launch
            val doc = CanvasDocument(noteId, ownerId) { upserts, deletes -> sync.submit(noteId, upserts, deletes) }
            doc.load(sync.cachedObjects(noteId))
            importedPdf = doc.all.hasImportedPdf()
            pageCount = settings.pageCount(noteId)
            view.open(doc, note.canvasMode, pageCount, note.background, settings.camera(noteId))
            refreshPageChrome(view)
            refreshHistory()
            if (note.canvasMode == "paged") runCatching { api.pageCount(noteId) }.getOrNull()?.let { applyPageCount(view, noteId, it) }
            runCatching { sync.refreshNote(noteId) }.onSuccess { objects ->
                if (view.document === doc) {
                    doc.applyRemote(objects, doc.all.map { it.id }.filter { id -> objects.none { it.id == id } }, view.protectedIds())
                    importedPdf = doc.all.hasImportedPdf()
                }
            }.onFailure { error = "Showing the copy saved on this tablet: ${it.message}" }
        }
    }

    fun addPageBelow() {
        val noteId = openNoteId ?: return
        val view = canvas ?: return
        scope.launch {
            runCatching { api.addPageBelow(noteId, view.currentPageIndex()) }
                .onSuccess {
                    applyPageCount(view, noteId, it)
                    view.scrollToPage(view.currentPageIndex() + 1); refreshPageChrome(view)
                }
                .onFailure { error = "Could not add a page: ${it.message}" }
        }
    }

    /** Reconnects after the server address changes. */
    fun restart() {
        sync.stop()
        sync.start()
        scope.launch { refreshLibrary(); openNoteId?.let { open(it) } }
    }

    /** Saves a reordered or edited account palette, shown immediately and shared with every device. */
    fun setDrawingPalette(palette: List<String>) {
        val previous = account ?: return
        account = previous.copy(drawingPalette = palette)
        scope.launch {
            runCatching { api.setDrawingPalette(palette) }.onFailure {
                account = previous
                error = "Could not save the drawing palette: ${it.message}"
            }
        }
    }

    /** Uploads a scanned page and places it in the middle of the open note, like the web's scan import. */
    fun importScan(name: String, jpeg: ByteArray) {
        val view = canvas ?: return
        val size = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        android.graphics.BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, size)
        if (size.outWidth <= 0 || size.outHeight <= 0) { error = "The scan could not be read"; return }
        scope.launch {
            runCatching { api.uploadFile(name, jpeg, "image/jpeg") }
                .onSuccess { fileId -> view.insertImage(fileId, name, size.outWidth, size.outHeight) }
                .onFailure { error = "Image import failed: ${it.message}" }
        }
    }

    fun undo() { canvas?.document?.undo() }
    fun redo() { canvas?.document?.redo() }

    fun launch(block: suspend () -> Unit) = scope.launch {
        try { block(); refreshLibrary() } catch (e: Exception) { error = e.message }
    }
}

private tailrec fun android.content.Context.activity(): android.app.Activity? = when (this) {
    is android.app.Activity -> this
    is android.content.ContextWrapper -> baseContext.activity()
    else -> null
}
