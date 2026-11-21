// The native note canvas: camera, background, scene drawing, and stylus/finger input.
// The scene is recorded once into a RenderNode in world units, so panning and zooming
// only change a matrix, and dragging a selection only moves the lifted objects.
package app.aurora.notes.canvas

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.MotionEvent
import android.view.View
import app.aurora.notes.data.Background
import app.aurora.notes.data.Bounds
import app.aurora.notes.data.Camera
import app.aurora.notes.data.CanvasObject
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.UUID
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

enum class Tool { Select, Lasso, Pan, Pen, Highlighter, Eraser, Line, Rectangle, Ellipse, Arrow, Matrix }

private const val MIN_ZOOM = 0.1
private const val MAX_ZOOM = 8.0
private const val TOOLBAR_CLEARANCE = 80.0
private const val ERASER_TOLERANCE_DP = 10.0
private const val MARQUEE_MIN_DP = 4.0
private const val PALM_REJECT_MS = 400L
private const val PEN_WIDTH = 2.5
private const val ACCENT = 0xFF6C9EFF.toInt()
/** color-mix(in srgb, --bg 78%, --surface-sunken), the web's canvas viewport. */
private const val VIEWPORT_COLOR = 0xFF14171F.toInt()

class CanvasView(context: Context) : View(context) {
    private val density = resources.displayMetrics.density.toDouble()
    private val renderer = SceneRenderer()
    private val surfaces = SurfacePainter(density.toFloat())
    private val tiles = TileCache(renderer).apply {
        under = UnderPainter { canvas, area, scale ->
            val doc = document ?: return@UnderPainter
            surfaces.paint(canvas, area, surfaceFrames(doc.all, mode, pageCount), mode == "infinite", background, mode == "paged", scale)
        }
    }
    private var shownExcluded: Set<String> = emptySet()

    var document: CanvasDocument? = null
        private set
    private var mode = "infinite"
    private var pageCount = 1
    private var background = Background()

    var camera = Camera(-64.0, -96.0, 1.0)
        private set
    private var cameraInitialized = false
    private var pendingCamera: Camera? = null

    var tool = Tool.Pen
        set(value) {
            if (value == field) return
            field = value
            cancelGesture()
        }
    var penColor = "#e6e8ec"
    var highlighterColor = "#ffe066"
    var highlighterWidth = 16.0

    var onCameraChanged: ((Camera) -> Unit)? = null
    var onSelectionChanged: ((Int) -> Unit)? = null
    var onDocumentChanged: (() -> Unit)? = null

    val selection = LinkedHashSet<String>()

    /** Fires when anything the floating chrome depends on moves: camera, selection, gestures. */
    var onChromeChanged: (() -> Unit)? = null

    // ---- Note lifecycle --------------------------------------------------

    /** Shows a note. A saved camera is restored as-is; otherwise the note opens at its default position. */
    fun open(doc: CanvasDocument, mode: String, pageCount: Int, background: Background, saved: Camera?) {
        cancelGesture()
        document?.listener = null
        document = doc
        this.mode = mode
        this.pageCount = pageCount
        this.background = background
        selection.clear()
        onSelectionChanged?.invoke(0)
        doc.listener = {
            selection.retainAll { doc[it] != null }
            onSelectionChanged?.invoke(selection.size)
            onDocumentChanged?.invoke()
            invalidate()
        }
        tiles.clear()
        shownExcluded = emptySet()
        cameraInitialized = false
        pendingCamera = saved
        if (width > 0) initializeCamera()
        invalidate()
    }

    fun setPageCount(count: Int) { pageCount = count; tiles.invalidateAll(); invalidate() }

    private fun initializeCamera() {
        if (cameraInitialized || document == null) return
        cameraInitialized = true
        val saved = pendingCamera
        camera = when {
            saved != null -> saved
            mode == "infinite" -> Camera(-64.0, -96.0, 1.0)
            else -> {
                val visibleW = width / density
                val limits = scrollLimits(document!!.all, mode, visibleW, height / density, pageCount)
                Camera(((limits?.contentWidth ?: PAGE_WIDTH) - visibleW) / 2, max(limits?.minY ?: 0.0, -TOOLBAR_CLEARANCE), 1.0)
            }
        }
        onCameraChanged?.invoke(camera)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        initializeCamera()
    }

    // ---- Camera ----------------------------------------------------------

    private val scale get() = camera.zoom * density
    private fun worldX(sx: Float) = camera.x + sx / scale
    private fun worldY(sy: Float) = camera.y + sy / scale

    /** Applies a user camera move, keeping bounded notes inside their scroll limits. */
    private fun moveCamera(next: Camera) {
        val zoom = next.zoom.coerceIn(MIN_ZOOM, MAX_ZOOM)
        var x = if (lockX && (mode == "paged" || mode == "fixed-width") && zoom == camera.zoom) camera.x else next.x
        var y = next.y
        val doc = document
        if (doc != null) {
            val limits = scrollLimits(doc.all, mode, width / (zoom * density), height / (zoom * density), pageCount)
            if (limits != null) {
                x = x.coerceIn(limits.minX, limits.maxX)
                y = y.coerceIn(limits.minY, limits.maxY)
            }
        }
        val clamped = Camera(x, y, zoom)
        if (clamped == camera) return
        camera = clamped
        onCameraChanged?.invoke(camera)
        onChromeChanged?.invoke()
        invalidate()
    }

    fun scrollToPage(index: Int) {
        moveCamera(camera.copy(y = pagedFrame(index).y - 40 / camera.zoom))
    }

    /** Zero-based page at the middle of the screen, for "add page below". */
    fun currentPageIndex(): Int = pageIndexAtY(worldY(height / 2f)).coerceIn(0, max(0, pageCount - 1))

    // ---- Gestures --------------------------------------------------------

    private sealed interface Gesture
    private class Ink(val highlighter: Boolean) : Gesture {
        var samples = FloatArray(256)
        var count = 0
        val groups = HashMap<Int, Path>()
        val path = Path()
        fun add(x: Float, y: Float, p: Float) {
            if (count * 3 + 3 > samples.size) samples = samples.copyOf(samples.size * 2)
            samples[count * 3] = x; samples[count * 3 + 1] = y; samples[count * 3 + 2] = p
            count++
        }
    }
    private class Erase(var lastX: Double, var lastY: Double) : Gesture { val removed = LinkedHashMap<String, CanvasObject>() }
    private class Marquee(val lasso: Boolean, val base: Set<String>) : Gesture {
        var points = FloatArray(128); var count = 0
        fun add(x: Float, y: Float) {
            if (count * 2 + 2 > points.size) points = points.copyOf(points.size * 2)
            points[count * 2] = x; points[count * 2 + 1] = y; count++
        }
        fun polygon(): FloatArray {
            if (lasso) return points.copyOf(count * 2)
            val ax = points[0]; val ay = points[1]; val bx = points[(count - 1) * 2]; val by = points[(count - 1) * 2 + 1]
            return floatArrayOf(ax, ay, bx, ay, bx, by, ax, by)
        }
    }
    private class Move(val startX: Double, val startY: Double, val origins: Map<String, CanvasObject>) : Gesture {
        var dx = 0.0; var dy = 0.0
    }
    private class Create(val tool: Tool, val startX: Double, val startY: Double) : Gesture {
        var x = startX; var y = startY
    }

    private var gesture: Gesture? = null
        set(value) { field = value; onChromeChanged?.invoke() }
    private var penPointerId = -1
    private var lastPenUpAt = 0L

    // Finger navigation state.
    private var panPointerId = -1
    private var lastPanX = 0f
    private var lastPanY = 0f
    private var pinchSpan = 0f
    private var pinchFocusX = 0f
    private var pinchFocusY = 0f

    private fun cancelGesture() {
        gesture = null
        penPointerId = -1
        invalidate()
    }

    private fun isPen(event: MotionEvent, index: Int): Boolean {
        val type = event.getToolType(index)
        return type == MotionEvent.TOOL_TYPE_STYLUS || type == MotionEvent.TOOL_TYPE_ERASER || type == MotionEvent.TOOL_TYPE_MOUSE
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        val doc = document ?: return false
        val index = event.actionIndex
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                if (isPen(event, index) && penPointerId == -1) {
                    // A pen landing ends any finger navigation in progress.
                    panPointerId = -1; pinchSpan = 0f
                    penPointerId = event.getPointerId(index)
                    requestUnbufferedDispatch(event)
                    if (tool == Tool.Pan) {
                        panPointerId = penPointerId
                        lastPanX = event.getX(index); lastPanY = event.getY(index)
                    } else {
                        penDown(doc, event, index)
                    }
                } else if (!isPen(event, index)) {
                    fingerDown(event)
                }
            }
            MotionEvent.ACTION_MOVE -> {
                val penIndex = if (penPointerId != -1) event.findPointerIndex(penPointerId) else -1
                if (penIndex >= 0 && tool != Tool.Pan) penMove(doc, event, penIndex)
                else fingerMove(event)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
                val id = event.getPointerId(index)
                if (id == penPointerId) {
                    if (tool != Tool.Pan) penUp(doc, event, index)
                    penPointerId = -1
                    panPointerId = -1
                    lastPenUpAt = event.eventTime
                } else {
                    fingerUp(event, id)
                }
            }
            MotionEvent.ACTION_CANCEL -> {
                cancelPenGesture()
                penPointerId = -1; panPointerId = -1; pinchSpan = 0f
            }
        }
        return true
    }

    // ---- Finger navigation -------------------------------------------------

    private fun fingerRejected(event: MotionEvent) =
        penPointerId != -1 || event.eventTime - lastPenUpAt < PALM_REJECT_MS

    private fun fingers(event: MotionEvent): List<Int> =
        (0 until event.pointerCount).filter { !isPen(event, it) && !(event.actionMasked == MotionEvent.ACTION_POINTER_UP && it == event.actionIndex) }

    private fun fingerDown(event: MotionEvent) {
        if (fingerRejected(event)) return
        resetFingerState(event)
    }

    private fun resetFingerState(event: MotionEvent) {
        val active = fingers(event)
        if (active.size >= 2) {
            val a = active[0]; val b = active[1]
            pinchSpan = hypot(event.getX(a) - event.getX(b), event.getY(a) - event.getY(b))
            pinchFocusX = (event.getX(a) + event.getX(b)) / 2
            pinchFocusY = (event.getY(a) + event.getY(b)) / 2
            panPointerId = -1
        } else if (active.size == 1) {
            pinchSpan = 0f
            panPointerId = event.getPointerId(active[0])
            lastPanX = event.getX(active[0]); lastPanY = event.getY(active[0])
        } else {
            pinchSpan = 0f; panPointerId = -1
        }
        invalidate()
    }

    private fun fingerMove(event: MotionEvent) {
        if (penPointerId != -1 && tool != Tool.Pan) return
        val active = if (tool == Tool.Pan && penPointerId != -1) listOf(event.findPointerIndex(penPointerId)) else fingers(event)
        if (pinchSpan > 0f && active.size >= 2) {
            val a = active[0]; val b = active[1]
            val span = hypot(event.getX(a) - event.getX(b), event.getY(a) - event.getY(b))
            val fx = (event.getX(a) + event.getX(b)) / 2
            val fy = (event.getY(a) + event.getY(b)) / 2
            val zoom = (camera.zoom * span / pinchSpan).coerceIn(MIN_ZOOM, MAX_ZOOM)
            // Keep the world point under the previous focus under the new focus.
            val wx = worldX(pinchFocusX); val wy = worldY(pinchFocusY)
            val newScale = zoom * density
            moveCamera(Camera(wx - fx / newScale, wy - fy / newScale, zoom))
            pinchSpan = span; pinchFocusX = fx; pinchFocusY = fy
            return
        }
        val index = if (panPointerId != -1) event.findPointerIndex(panPointerId) else -1
        if (index < 0) return
        val x = event.getX(index); val y = event.getY(index)
        moveCamera(camera.copy(x = camera.x - (x - lastPanX) / scale, y = camera.y - (y - lastPanY) / scale))
        lastPanX = x; lastPanY = y
    }

    private fun fingerUp(event: MotionEvent, id: Int) {
        if (event.actionMasked == MotionEvent.ACTION_UP) { panPointerId = -1; pinchSpan = 0f; invalidate(); return }
        if (id == panPointerId || pinchSpan > 0f) resetFingerState(event)
    }

    // ---- Pen tools -------------------------------------------------------

    private fun penDown(doc: CanvasDocument, event: MotionEvent, index: Int) {
        val wx = worldX(event.getX(index)); val wy = worldY(event.getY(index))
        val eraserEnd = event.getToolType(index) == MotionEvent.TOOL_TYPE_ERASER
        gesture = when {
            eraserEnd || tool == Tool.Eraser -> Erase(wx, wy).also { eraseAt(doc, it, wx, wy) }
            tool == Tool.Pen || tool == Tool.Highlighter -> Ink(tool == Tool.Highlighter).also { addInk(it, event, index, wx, wy) }
            tool == Tool.Select -> startSelect(doc, wx, wy)
            tool == Tool.Lasso -> startMove(doc, wx, wy) ?: startMarquee(true, wx, wy)
            else -> Create(tool, wx, wy)
        }
        invalidate()
    }

    private fun penMove(doc: CanvasDocument, event: MotionEvent, index: Int) {
        when (val g = gesture) {
            is Ink -> {
                for (h in 0 until event.historySize) {
                    addInk(g, event, index, worldX(event.getHistoricalX(index, h)), worldY(event.getHistoricalY(index, h)), h)
                }
                addInk(g, event, index, worldX(event.getX(index)), worldY(event.getY(index)))
            }
            is Erase -> {
                val wx = worldX(event.getX(index)); val wy = worldY(event.getY(index))
                val tolerance = ERASER_TOLERANCE_DP / camera.zoom
                val steps = max(1, (hypot(wx - g.lastX, wy - g.lastY) / tolerance).toInt() + 1)
                for (i in 1..steps) eraseAt(doc, g, g.lastX + (wx - g.lastX) * i / steps, g.lastY + (wy - g.lastY) * i / steps)
                g.lastX = wx; g.lastY = wy
            }
            is Marquee -> {
                val x = worldX(event.getX(index)).toFloat(); val y = worldY(event.getY(index)).toFloat()
                if (!g.lasso) { if (g.count > 1) g.count = 1; g.add(x, y) }
                else {
                    val lx = g.points[(g.count - 1) * 2]; val ly = g.points[(g.count - 1) * 2 + 1]
                    if (hypot(x - lx, y - ly) * camera.zoom >= 2) g.add(x, y)
                }
            }
            is Move -> { g.dx = worldX(event.getX(index)) - g.startX; g.dy = worldY(event.getY(index)) - g.startY }
            is Create -> { g.x = worldX(event.getX(index)); g.y = worldY(event.getY(index)) }
            null -> return
        }
        invalidate()
    }

    private fun penUp(doc: CanvasDocument, event: MotionEvent, index: Int) {
        val g = gesture ?: return
        gesture = null
        when (g) {
            is Ink -> commitInk(doc, g)
            is Erase -> if (g.removed.isNotEmpty()) doc.edit(g.removed.values.toList(), emptyList())
            is Marquee -> finishMarquee(doc, g)
            is Move -> commitMove(doc, g)
            is Create -> commitShape(doc, g)
        }
        invalidate()
    }

    private fun cancelPenGesture() {
        gesture = null
        invalidate()
    }

    private fun addInk(g: Ink, event: MotionEvent, index: Int, wx: Double, wy: Double, historical: Int = -1) {
        val stylus = event.getToolType(index) == MotionEvent.TOOL_TYPE_STYLUS
        val pressure = if (!stylus) 0.5f
        else if (historical >= 0) event.getHistoricalPressure(index, historical) else event.getPressure(index)
        if (stylus && pressure <= 0f) return
        val x = wx.toFloat(); val y = wy.toFloat()
        if (g.count > 0) {
            val px = g.samples[(g.count - 1) * 3]; val py = g.samples[(g.count - 1) * 3 + 1]
            if (px == x && py == y) return
            if (g.highlighter) g.path.lineTo(x, y)
            else {
                val level = (g.samples[(g.count - 1) * 3 + 2].coerceIn(0f, 1f) * 32).roundToInt()
                g.groups.getOrPut(level) { Path() }.apply { moveTo(px, py); lineTo(x, y) }
            }
        } else {
            g.path.moveTo(x, y)
        }
        g.add(x, y, pressure.coerceIn(0f, 1f))
    }

    private fun newObject(doc: CanvasDocument, kind: String, bounds: Bounds, payload: JsonObject): CanvasObject {
        val now = nowIso()
        return CanvasObject(
            id = UUID.randomUUID().toString(), ownerId = doc.ownerId, noteId = doc.noteId, kind = kind,
            bounds = bounds, zIndex = doc.nextZIndex(), payload = payload, createdAt = now, updatedAt = now,
        )
    }

    private fun commitInk(doc: CanvasDocument, g: Ink) {
        if (g.count < 1) return
        val samples = g.samples.copyOf(g.count * 3)
        val width = if (g.highlighter) highlighterWidth else PEN_WIDTH
        val raw = boundsOfPoints(samples, if (g.highlighter) width else width * 2)
        val bounds = clampToMode(raw, mode)
        val dx = (bounds.x - raw.x).toFloat(); val dy = (bounds.y - raw.y).toFloat()
        if (dx != 0f || dy != 0f) for (i in 0 until g.count) { samples[i * 3] += dx; samples[i * 3 + 1] += dy }
        val color = if (g.highlighter) highlighterColor else penColor
        doc.edit(emptyList(), listOf(newObject(doc, "stroke", bounds, pointsPayload(samples, color, width, g.highlighter))))
    }

    private fun eraseAt(doc: CanvasDocument, g: Erase, x: Double, y: Double) {
        val candidates = doc.all.filter { it.id !in g.removed }
        val hit = hitStroke(candidates, x, y, ERASER_TOLERANCE_DP / camera.zoom, renderer::samples) ?: return
        g.removed[hit.id] = hit
    }

    // ---- Selection ---------------------------------------------------------

    private fun selectedObjects(doc: CanvasDocument) = selection.mapNotNull { doc[it] }.filter { !it.locked }

    private fun startMove(doc: CanvasDocument, wx: Double, wy: Double): Move? {
        val selected = selectedObjects(doc)
        val bounds = unionBounds(selected.map { it.bounds }) ?: return null
        if (!bounds.contains(wx, wy)) return null
        return Move(wx, wy, selected.associateBy { it.id })
    }

    private fun startSelect(doc: CanvasDocument, wx: Double, wy: Double): Gesture {
        startMove(doc, wx, wy)?.let { return it }
        val tolerance = ERASER_TOLERANCE_DP / camera.zoom
        val hit = hitStroke(doc.all, wx, wy, tolerance, renderer::samples)
            ?: hitBounds(doc.all.filter { it.kind != "stroke" && !it.locked }, wx, wy)
        if (hit != null) {
            setSelection(listOf(hit.id))
                return Move(wx, wy, mapOf(hit.id to hit))
        }
        return startMarquee(false, wx, wy)
    }

    private fun startMarquee(lasso: Boolean, wx: Double, wy: Double): Marquee {
        setSelection(emptyList())
        return Marquee(lasso, emptySet()).also { it.add(wx.toFloat(), wy.toFloat()) }
    }

    private fun finishMarquee(doc: CanvasDocument, g: Marquee) {
        if (g.count < 2) return
        val x0 = g.points[0]; val y0 = g.points[1]
        var extent = 0f
        for (i in 0 until g.count) extent = max(extent, hypot(g.points[i * 2] - x0, g.points[i * 2 + 1] - y0))
        if (extent * camera.zoom < MARQUEE_MIN_DP) return
        setSelection(g.base + objectsInLasso(doc.all, g.polygon(), renderer::samples).map { it.id })
    }

    private fun setSelection(ids: Collection<String>) {
        selection.clear(); selection.addAll(ids)
        onSelectionChanged?.invoke(selection.size)
        onChromeChanged?.invoke()
        invalidate()
    }

    private fun clampedOffset(origin: Bounds, dx: Double, dy: Double): Pair<Double, Double> {
        val moved = clampToMode(origin.translate(dx, dy), mode)
        return (moved.x - origin.x) to (moved.y - origin.y)
    }

    private fun commitMove(doc: CanvasDocument, g: Move) {
        if (g.dx == 0.0 && g.dy == 0.0) return
        val before = ArrayList<CanvasObject>(); val after = ArrayList<CanvasObject>()
        for ((id, origin) in g.origins) {
            val current = doc[id] ?: continue
            val (ox, oy) = clampedOffset(origin.bounds, g.dx, g.dy)
            if (ox == 0.0 && oy == 0.0) continue
            before += current
            after += current.movedTo(current.bounds.translate(ox, oy))
        }
        doc.edit(before, after)
    }

    fun deleteSelection() {
        val doc = document ?: return
        val targets = selectedObjects(doc)
        if (targets.isEmpty()) return
        doc.edit(targets, emptyList())
        setSelection(emptyList())
    }

    fun duplicateSelection() {
        val doc = document ?: return
        val targets = selectedObjects(doc).sortedBy { it.zIndex }
        if (targets.isEmpty()) return
        var z = doc.nextZIndex()
        val now = nowIso()
        val copies = targets.map { o ->
            o.movedTo(o.bounds.translate(24.0, 24.0)).copy(id = UUID.randomUUID().toString(), zIndex = z++, revision = 0, createdAt = now, updatedAt = now, groupId = null)
        }
        doc.edit(emptyList(), copies)
        setSelection(copies.map { it.id })
    }

    fun clearSelection() = setSelection(emptyList())

    /** Copies the selection to the in-app clipboard; `cut` also deletes it. */
    fun copySelection(cut: Boolean) {
        val doc = document ?: return
        val targets = selectedObjects(doc).sortedBy { it.zIndex }
        if (targets.isEmpty()) return
        clipboard = targets
        if (cut) deleteSelection()
        onSelectionChanged?.invoke(selection.size)
    }

    val canPaste get() = clipboard.isNotEmpty()

    /** Pastes beside the originals when they are on screen, otherwise centred in the view (as the web does). */
    fun paste() {
        val doc = document ?: return
        val source = clipboard
        if (source.isEmpty()) return
        val bounds = unionBounds(source.map { it.bounds }) ?: return
        val view = Bounds(camera.x, camera.y, width / scale, height / scale)
        val (dx, dy) = if (source.first().noteId == doc.noteId && bounds.intersects(view)) 24.0 to 24.0
        else (view.x + view.width / 2 - (bounds.x + bounds.width / 2)) to (view.y + view.height / 2 - (bounds.y + bounds.height / 2))
        var z = doc.nextZIndex()
        val now = nowIso()
        val copies = source.map { o ->
            o.movedTo(clampToMode(o.bounds.translate(dx, dy), mode)).copy(
                id = UUID.randomUUID().toString(), noteId = doc.noteId, ownerId = doc.ownerId, zIndex = z++,
                revision = 0, createdAt = now, updatedAt = now, groupId = null, pageId = null,
            )
        }
        doc.edit(emptyList(), copies)
        setSelection(copies.map { it.id })
    }

    /** Moves the selection above (`front`) or below everything else, keeping its internal order. */
    fun reorderSelection(front: Boolean) {
        val doc = document ?: return
        val targets = selectedObjects(doc).sortedBy { it.zIndex }
        if (targets.isEmpty()) return
        val others = doc.all.filter { it.id !in selection }
        var z = if (front) (others.maxOfOrNull { it.zIndex } ?: 0) + 1 else (others.minOfOrNull { it.zIndex } ?: 0) - targets.size
        val after = targets.map { it.copy(zIndex = z++) }
        doc.edit(targets, after)
    }

    /** Selection bounds in view pixels, or null when nothing is selected or a gesture is running. */
    fun selectionScreenRect(): RectF? {
        val doc = document ?: return null
        if (gesture != null) return null
        val b = unionBounds(selectedObjects(doc).map { it.bounds }) ?: return null
        return toScreen(b)
    }

    /** Locks horizontal scrolling on page-width notes, like the web's axis lock. */
    var lockX = false
        set(value) { field = value; invalidate() }

    /** Ids whose local state must not be replaced by server broadcasts right now. */
    fun protectedIds(): Set<String> = when (val g = gesture) {
        is Move -> g.origins.keys
        is Erase -> g.removed.keys
        else -> emptySet()
    }

    // ---- Shape creation ----------------------------------------------------

    private fun shapePayload(extra: Map<String, kotlinx.serialization.json.JsonElement> = emptyMap()) = JsonObject(
        mapOf("color" to JsonPrimitive(penColor), "strokeWidth" to JsonPrimitive(2), "lineStyle" to JsonPrimitive("solid")) + extra,
    )

    private fun commitShape(doc: CanvasDocument, g: Create) {
        val w = abs(g.x - g.startX); val h = abs(g.y - g.startY)
        if (w < 2 && h < 2) return
        val kind = when (g.tool) {
            Tool.Line -> "line"; Tool.Arrow -> "arrow"; Tool.Rectangle -> "rectangle"
            Tool.Ellipse -> "ellipse"; else -> "matrix"
        }
        val raw = Bounds(min(g.startX, g.x), min(g.startY, g.y), max(MIN_BOUNDS_SIZE, w), max(MIN_BOUNDS_SIZE, h))
        val bounds = clampToMode(raw, mode)
        val dx = bounds.x - raw.x; val dy = bounds.y - raw.y
        val payload = if (kind == "line" || kind == "arrow") shapePayload(mapOf(
            "start" to pointJson(Pt(g.startX + dx, g.startY + dy)),
            "end" to pointJson(Pt(g.x + dx, g.y + dy)),
        )) else shapePayload()
        doc.edit(emptyList(), listOf(newObject(doc, kind, bounds, payload)))
    }

    // ---- Drawing -----------------------------------------------------------

    private val outlinePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = ACCENT; strokeWidth = 1.5f }
    private val groupPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; color = 0xB36C9EFF.toInt(); strokeWidth = 1f; pathEffect = DashPathEffect(floatArrayOf(8f, 6f), 0f)
    }
    private val marqueeFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL; color = 0x1A6C9EFF }
    private val marqueeStroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE; color = ACCENT; strokeWidth = 1.25f; pathEffect = DashPathEffect(floatArrayOf(10f, 8f), 0f)
    }
    private val inkPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }

    override fun onDraw(canvas: Canvas) {
        val doc = document
        canvas.drawColor(if (mode == "infinite") parseColor(background.color) else VIEWPORT_COLOR)
        if (doc == null) return
        val s = scale.toFloat()


        syncTiles(doc)
        tiles.draw(canvas, camera.x, camera.y, scale, width, height, pinchSpan > 0f, doc.sorted, shownExcluded)
        canvas.save()
        canvas.scale(s, s)
        canvas.translate(-camera.x.toFloat(), -camera.y.toFloat())

        val move = gesture as? Move
        if (move != null) drawLifted(canvas, doc, move)
        drawWetInk(canvas)
        drawCreatePreview(canvas)
        canvas.restore()

        drawSelection(canvas, doc, move)
        drawMarquee(canvas)
    }

    // The dragged selection, rendered once into a GPU layer and moved as a whole.
    private var liftedNode: android.graphics.RenderNode? = null
    private var liftedFor: Move? = null
    private var liftedOrigin = Bounds(0.0, 0.0, 1.0, 1.0)
    private var liftedScale = 0.0

    private fun drawLifted(canvas: Canvas, doc: CanvasDocument, move: Move) {
        val lifted = doc.sorted.filter { it.id in move.origins }
        val uniform = lifted.all { o ->
            val (ox, oy) = clampedOffset(move.origins[o.id]!!.bounds, move.dx, move.dy)
            ox == move.dx && oy == move.dy
        }
        val node = if (uniform) liftedLayer(move, lifted) else null
        if (node == null) {
            // Some objects stopped at a page edge: draw each at its own clamped offset.
            for (o in lifted) {
                val (ox, oy) = clampedOffset(move.origins[o.id]!!.bounds, move.dx, move.dy)
                canvas.save(); canvas.translate(ox.toFloat(), oy.toFloat()); renderer.draw(canvas, o); canvas.restore()
            }
            return
        }
        // The canvas is in world units here; the layer was rendered at screen scale.
        canvas.save()
        canvas.translate((liftedOrigin.x + move.dx).toFloat(), (liftedOrigin.y + move.dy).toFloat())
        canvas.scale((1 / liftedScale).toFloat(), (1 / liftedScale).toFloat())
        canvas.drawRenderNode(node)
        canvas.restore()
    }

    private fun liftedLayer(move: Move, lifted: List<CanvasObject>): android.graphics.RenderNode? {
        if (liftedFor === move && liftedScale == scale) return liftedNode
        liftedNode?.discardDisplayList()
        liftedNode = null
        liftedFor = move
        liftedScale = scale
        val margin = 12.0
        val b = unionBounds(lifted.map { it.bounds }) ?: return null
        liftedOrigin = Bounds(b.x - margin, b.y - margin, b.width + margin * 2, b.height + margin * 2)
        val w = (liftedOrigin.width * scale).toInt() + 1
        val h = (liftedOrigin.height * scale).toInt() + 1
        if (w > 8192 || h > 8192) return null
        val node = android.graphics.RenderNode("lifted").apply { setPosition(0, 0, w, h); setUseCompositingLayer(true, null) }
        val c = node.beginRecording()
        try {
            c.scale(scale.toFloat(), scale.toFloat())
            c.translate(-liftedOrigin.x.toFloat(), -liftedOrigin.y.toFloat())
            for (o in lifted) renderer.draw(c, o)
        } finally {
            node.endRecording()
        }
        liftedNode = node
        return node
    }

    /** Re-renders tiles whose content changed: document edits and objects lifted or dropped by a gesture. */
    private fun syncTiles(doc: CanvasDocument) {
        if (doc.dirtyAll) {
            tiles.invalidateAll()
            doc.dirtyAll = false
            doc.dirty.clear()
            renderer.retain(doc.all.map { it.id }.toSet())
        } else if (doc.dirty.isNotEmpty()) {
            doc.dirty.forEach { tiles.invalidate(it) }
            doc.dirty.clear()
        }
        val excluded = protectedIds()
        if (excluded != shownExcluded) {
            for (id in (excluded - shownExcluded) + (shownExcluded - excluded)) {
                (doc[id] ?: (gesture as? Erase)?.removed?.get(id))?.let { tiles.invalidate(it.bounds) }
            }
            shownExcluded = excluded.toSet()
        }
    }

    private fun toScreen(b: Bounds): RectF {
        val s = scale
        return RectF(((b.x - camera.x) * s).toFloat(), ((b.y - camera.y) * s).toFloat(), ((b.right - camera.x) * s).toFloat(), ((b.bottom - camera.y) * s).toFloat())
    }

    private fun drawWetInk(canvas: Canvas) {
        val g = gesture as? Ink ?: return
        if (g.highlighter) {
            inkPaint.color = parseColor(highlighterColor)
            inkPaint.alpha = (HIGHLIGHTER_OPACITY * 255).roundToInt()
            inkPaint.strokeWidth = highlighterWidth.toFloat()
            canvas.drawPath(g.path, inkPaint)
            return
        }
        inkPaint.color = parseColor(penColor)
        inkPaint.alpha = 255
        if (g.count == 1) {
            inkPaint.strokeWidth = SceneRenderer.pressureWidth(PEN_WIDTH.toFloat(), g.samples[2])
            canvas.drawPoint(g.samples[0], g.samples[1], inkPaint)
        }
        for ((level, path) in g.groups) {
            inkPaint.strokeWidth = max(0.5f, PEN_WIDTH.toFloat() * (0.3f + level / 32f))
            canvas.drawPath(path, inkPaint)
        }
    }

    private fun drawCreatePreview(canvas: Canvas) {
        val g = gesture as? Create ?: return
        val doc = document ?: return
        val preview = newObject(doc, "rectangle", Bounds(min(g.startX, g.x), min(g.startY, g.y), max(1.0, abs(g.x - g.startX)), max(1.0, abs(g.y - g.startY))), shapePayload())
        val kind = when (g.tool) { Tool.Line -> "line"; Tool.Arrow -> "arrow"; Tool.Ellipse -> "ellipse"; Tool.Matrix -> "matrix"; else -> "rectangle" }
        val obj = if (kind == "line" || kind == "arrow") preview.copy(kind = kind, payload = shapePayload(mapOf(
            "start" to pointJson(Pt(g.startX, g.startY)), "end" to pointJson(Pt(g.x, g.y)),
        ))) else preview.copy(kind = kind)
        SceneRenderer().draw(canvas, obj)
    }

    private fun drawSelection(canvas: Canvas, doc: CanvasDocument, move: Move?) {
        if (selection.isEmpty()) return
        val r = 6 * density.toFloat()
        val boxes = ArrayList<Bounds>()
        for (id in selection) {
            val o = doc[id] ?: continue
            var b = o.bounds
            if (move != null) move.origins[id]?.let { val (ox, oy) = clampedOffset(it.bounds, move.dx, move.dy); b = it.bounds.translate(ox, oy) }
            boxes += b
            canvas.drawRoundRect(toScreen(b), r, r, outlinePaint)
        }
        if (boxes.size > 1) {
            val pad = 6 * density.toFloat()
            val g = toScreen(unionBounds(boxes)!!)
            g.inset(-pad, -pad)
            canvas.drawRoundRect(g, r, r, groupPaint)
        }
    }

    private fun drawMarquee(canvas: Canvas) {
        val g = gesture as? Marquee ?: return
        if (g.count < 2) return
        val poly = g.polygon()
        val path = Path()
        for (i in 0 until poly.size / 2) {
            val sx = ((poly[i * 2] - camera.x) * scale).toFloat(); val sy = ((poly[i * 2 + 1] - camera.y) * scale).toFloat()
            if (i == 0) path.moveTo(sx, sy) else path.lineTo(sx, sy)
        }
        path.close()
        path.fillType = Path.FillType.EVEN_ODD
        canvas.drawPath(path, marqueeFill)
        canvas.drawPath(path, marqueeStroke)
    }

    companion object {
        /** Copied objects, shared across notes for pasting elsewhere. */
        private var clipboard: List<CanvasObject> = emptyList()
    }
}
