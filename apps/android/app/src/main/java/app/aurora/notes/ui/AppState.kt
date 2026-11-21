// App-level state: the library tree, the open note, and the bridge between the canvas and sync.
package app.aurora.notes.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.aurora.notes.canvas.CanvasDocument
import app.aurora.notes.canvas.CanvasView
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
import kotlinx.coroutines.launch

class AppState(context: Context) {
    val settings = Settings(context)
    private val store = LocalStore(context)
    val api = AuroraApi(settings)
    val sync = SyncEngine(api, store, settings)
    private val images = app.aurora.notes.canvas.ImageStore(context, api)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

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
    var penColor by mutableStateOf<String?>(null)
    var zoom by mutableStateOf(1.0)
        private set
    var currentPage by mutableStateOf(0)
        private set
    var canPaste by mutableStateOf(false)
        private set
    /** Bumped whenever floating canvas chrome (the selection bar) must be repositioned. */
    var chromeTick by mutableStateOf(0)
        private set
    private var lockXState by mutableStateOf(false)
    var lockX: Boolean
        get() = lockXState
        set(value) { lockXState = value; canvas?.lockX = value }

    val openNote: LibraryNote? get() = library.notes.firstOrNull { it.id == openNoteId }

    private var canvas: CanvasView? = null
    private var cameraSave: Job? = null
    private var openJob: Job? = null

    init {
        scope.launch { sync.remoteChanges.collect { change ->
            val view = canvas ?: return@collect
            val doc = view.document ?: return@collect
            if (change.noteId == doc.noteId) doc.applyRemote(change.objects, change.deletedIds, view.protectedIds())
        } }
        scope.launch { sync.libraryChanged.collect { refreshLibrary() } }
        scope.launch {
            store.readLibrary()?.let { library = it }
            refreshLibrary()
            settings.lastNoteId?.let { id -> if (library.notes.any { it.id == id && !it.trashed }) open(id) }
        }
    }

    fun attach(view: CanvasView) {
        canvas = view
        view.images = images
        view.onSelectionChanged = { selectionCount = it; refreshChrome() }
        view.onChromeChanged = { refreshChrome() }
        view.onDocumentChanged = { refreshHistory() }
        view.onCameraChanged = { camera ->
            zoom = camera.zoom
            currentPage = view.currentPageIndex()
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

    private fun refreshHistory() {
        val doc = canvas?.document
        canUndo = doc?.canUndo == true
        canRedo = doc?.canRedo == true
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
        val note = library.notes.firstOrNull { it.id == noteId } ?: return
        val view = canvas ?: return
        openJob?.cancel()
        openJob = scope.launch {
            val ownerId = account?.ownerId ?: runCatching { api.account().also { account = it } }.getOrNull()?.ownerId ?: return@launch
            val doc = CanvasDocument(noteId, ownerId) { upserts, deletes -> sync.submit(noteId, upserts, deletes) }
            doc.load(sync.cachedObjects(noteId))
            pageCount = settings.pageCount(noteId)
            view.open(doc, note.canvasMode, pageCount, note.background, settings.camera(noteId))
            refreshHistory()
            if (note.canvasMode == "paged") runCatching { api.pageCount(noteId) }.getOrNull()?.let {
                pageCount = it; settings.savePageCount(noteId, it); view.setPageCount(it)
            }
            runCatching { sync.refreshNote(noteId) }.onSuccess { objects ->
                if (view.document === doc) doc.applyRemote(objects, doc.all.map { it.id }.filter { id -> objects.none { it.id == id } }, view.protectedIds())
            }.onFailure { error = "Showing the copy saved on this tablet: ${it.message}" }
        }
    }

    fun addPageBelow() {
        val noteId = openNoteId ?: return
        val view = canvas ?: return
        scope.launch {
            runCatching { api.addPageBelow(noteId, view.currentPageIndex()) }
                .onSuccess { pageCount = it; settings.savePageCount(noteId, it); view.setPageCount(it); view.scrollToPage(view.currentPageIndex() + 1) }
                .onFailure { error = "Could not add a page: ${it.message}" }
        }
    }

    /** Reconnects after the server address changes. */
    fun restart() {
        sync.stop()
        sync.start()
        scope.launch { refreshLibrary(); openNoteId?.let { open(it) } }
    }

    fun undo() { canvas?.document?.undo() }
    fun redo() { canvas?.document?.redo() }

    fun launch(block: suspend () -> Unit) = scope.launch {
        try { block(); refreshLibrary() } catch (e: Exception) { error = e.message }
    }
}
