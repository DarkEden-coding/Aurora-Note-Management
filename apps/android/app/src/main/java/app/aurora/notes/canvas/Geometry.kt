// Canvas geometry shared by rendering and input: page layout per mode, clamping, scroll limits, hit tests, and lasso containment. Mirrors features/canvas/pageLayout.ts and selectionRegion.ts.
package app.aurora.notes.canvas

import app.aurora.notes.data.Bounds
import app.aurora.notes.data.CanvasObject
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

const val PAGE_WIDTH = 816.0
const val PAGE_HEIGHT = 1056.0
const val PAGE_GAP = 24.0
private const val OPEN_AXIS_EXTENT = 100_000.0
const val MIN_BOUNDS_SIZE = 8.0

fun pagedFrame(index: Int) = Bounds(0.0, index * (PAGE_HEIGHT + PAGE_GAP), PAGE_WIDTH, PAGE_HEIGHT)

fun pageIndexAtY(y: Double): Int = if (y >= 0) floor((y + PAGE_GAP) / (PAGE_HEIGHT + PAGE_GAP)).toInt() else 0

/** Patterned writing surfaces drawn under the content for each mode. */
/** Imported PDF notes: the PDF pages are the surface, so no sheets are drawn and pages can't be added. */
fun Collection<CanvasObject>.hasImportedPdf() =
    any { it.kind == "pdf-page-reference" && it.payload["importedDocument"]?.toString() == "true" }

fun surfaceFrames(objects: Collection<CanvasObject>, mode: String, pageCount: Int): List<Bounds> {
    if (objects.hasImportedPdf()) return emptyList()
    return when (mode) {
        "fixed-width" -> listOf(Bounds(0.0, 0.0, PAGE_WIDTH, OPEN_AXIS_EXTENT))
        "fixed-height" -> listOf(Bounds(0.0, 0.0, OPEN_AXIS_EXTENT, PAGE_HEIGHT))
        "paged" -> (0 until max(1, pageCount)).map { pagedFrame(it) }
        else -> emptyList()
    }
}

private fun clampToRegion(b: Bounds, rx: Double, ry: Double, rw: Double, rh: Double): Bounds {
    val x = if (rw.isFinite()) (if (b.width >= rw) rx else b.x.coerceIn(rx, rx + rw - b.width)) else b.x
    val y = if (rh.isFinite()) (if (b.height >= rh) ry else b.y.coerceIn(ry, ry + rh - b.height)) else b.y
    return b.copy(x = x, y = y)
}

/** Keeps content inside the writable region of the canvas mode. */
fun clampToMode(b: Bounds, mode: String): Bounds = when (mode) {
    "fixed-width", "paged" -> clampToRegion(b, 0.0, Double.NEGATIVE_INFINITY, PAGE_WIDTH, Double.POSITIVE_INFINITY)
    "fixed-height" -> clampToRegion(b, Double.NEGATIVE_INFINITY, 0.0, Double.POSITIVE_INFINITY, PAGE_HEIGHT)
    else -> b
}

data class ScrollLimits(val minX: Double, val maxX: Double, val minY: Double, val maxY: Double, val contentWidth: Double)

private fun axis(content: Double, visible: Double): Pair<Double, Double> {
    val lo = -visible * 0.25
    val hi = content - visible * 0.75
    if (lo <= hi) return lo to hi
    val centered = (content - visible) / 2
    return centered to centered
}

/** Camera limits that keep content on screen; null on an infinite canvas. */
fun scrollLimits(objects: Collection<CanvasObject>, mode: String, visibleW: Double, visibleH: Double, pageCount: Int): ScrollLimits? {
    if (mode == "infinite" || visibleW <= 0 || visibleH <= 0) return null
    var right = 0.0
    var bottom = 0.0
    for (o in objects) { right = max(right, o.bounds.right); bottom = max(bottom, o.bounds.bottom) }
    val contentW = if (mode == "fixed-height") max(PAGE_WIDTH, right) else PAGE_WIDTH
    val contentH = when (mode) {
        "paged" -> max(pagedFrame(max(1, pageCount) - 1).bottom, bottom)
        "fixed-width" -> max(PAGE_HEIGHT, bottom)
        else -> PAGE_HEIGHT
    }
    var (minX, maxX) = axis(contentW, visibleW)
    var (minY, maxY) = axis(contentH, visibleH)
    if (mode == "fixed-width" || mode == "paged") maxY = max(minY, contentH + visibleH * 0.25)
    if (mode == "fixed-height") maxX = max(minX, contentW + visibleW * 0.25)
    return ScrollLimits(minX, maxX, minY, maxY, contentW)
}

fun unionBounds(list: Collection<Bounds>): Bounds? {
    if (list.isEmpty()) return null
    var l = Double.POSITIVE_INFINITY; var t = l; var r = Double.NEGATIVE_INFINITY; var b = r
    for (x in list) { l = min(l, x.x); t = min(t, x.y); r = max(r, x.right); b = max(b, x.bottom) }
    return Bounds(l, t, r - l, b - t)
}

fun boundsOfPoints(samples: FloatArray, padding: Double): Bounds {
    var l = Double.POSITIVE_INFINITY; var t = l; var r = Double.NEGATIVE_INFINITY; var b = r
    for (i in 0 until samples.size / 3) {
        val x = samples[i * 3].toDouble(); val y = samples[i * 3 + 1].toDouble()
        l = min(l, x); t = min(t, y); r = max(r, x); b = max(b, y)
    }
    if (!l.isFinite()) return Bounds(0.0, 0.0, MIN_BOUNDS_SIZE, MIN_BOUNDS_SIZE)
    return Bounds(l - padding, t - padding, max(MIN_BOUNDS_SIZE, r - l + padding * 2), max(MIN_BOUNDS_SIZE, b - t + padding * 2))
}

fun distanceToSegment(px: Double, py: Double, ax: Double, ay: Double, bx: Double, by: Double): Double {
    val dx = bx - ax; val dy = by - ay
    if (dx == 0.0 && dy == 0.0) return hypot(px - ax, py - ay)
    val t = (((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)).coerceIn(0.0, 1.0)
    return hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Topmost unlocked stroke whose path passes within the tolerance of a point. */
fun hitStroke(objects: Collection<CanvasObject>, x: Double, y: Double, tolerance: Double, samples: (CanvasObject) -> StrokeSamples): CanvasObject? {
    var best: CanvasObject? = null
    for (o in objects) {
        if (o.kind != "stroke" || o.locked) continue
        val reach = if (o.isHighlighter) tolerance + o.strokeBaseWidth / 2 else tolerance
        val b = o.bounds
        if (x < b.x - reach || x > b.right + reach || y < b.y - reach || y > b.bottom + reach) continue
        val s = samples(o)
        var hit = false
        for (i in 0 until s.size) {
            val d = if (i == 0) hypot(s.x(0) - x, s.y(0) - y)
            else distanceToSegment(x, y, s.x(i - 1).toDouble(), s.y(i - 1).toDouble(), s.x(i).toDouble(), s.y(i).toDouble())
            if (d <= reach) { hit = true; break }
        }
        if (hit && (best == null || o.zIndex >= best.zIndex)) best = o
    }
    return best
}

/** Topmost object whose bounds contain the point. */
fun hitBounds(objects: Collection<CanvasObject>, x: Double, y: Double): CanvasObject? {
    var best: CanvasObject? = null
    for (o in objects) if (o.bounds.contains(x, y) && (best == null || o.zIndex >= best.zIndex)) best = o
    return best
}

fun pointInPolygon(x: Double, y: Double, poly: FloatArray): Boolean {
    var inside = false
    val n = poly.size / 2
    var j = n - 1
    for (i in 0 until n) {
        val ax = poly[i * 2]; val ay = poly[i * 2 + 1]; val bx = poly[j * 2]; val by = poly[j * 2 + 1]
        if ((ay > y) != (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside
        j = i
    }
    return inside
}

/** Objects enclosed by a lasso: ink when most of its points are inside, anything else when fully inside. */
fun objectsInLasso(objects: Collection<CanvasObject>, poly: FloatArray, samples: (CanvasObject) -> StrokeSamples): List<CanvasObject> {
    if (poly.size < 6) return emptyList()
    var l = Float.POSITIVE_INFINITY; var t = l; var r = Float.NEGATIVE_INFINITY; var b = r
    for (i in 0 until poly.size / 2) { l = min(l, poly[i * 2]); r = max(r, poly[i * 2]); t = min(t, poly[i * 2 + 1]); b = max(b, poly[i * 2 + 1]) }
    val region = Bounds(l.toDouble(), t.toDouble(), (r - l).toDouble(), (b - t).toDouble())
    fun inside(x: Double, y: Double) = region.contains(x, y) && pointInPolygon(x, y, poly)
    return objects.filter { o ->
        if (o.locked || !o.bounds.intersects(region)) return@filter false
        when (o.kind) {
            "stroke" -> {
                val s = samples(o)
                if (s.size == 0) return@filter false
                var count = 0
                for (i in 0 until s.size) if (inside(s.x(i).toDouble(), s.y(i).toDouble())) count++
                count >= max(1.0, s.size * 0.5)
            }
            "line", "arrow" -> {
                val (a, e) = o.lineEndpoints()
                inside(a.x, a.y) && inside(e.x, e.y)
            }
            else -> {
                val bb = o.bounds
                inside(bb.x, bb.y) && inside(bb.right, bb.y) && inside(bb.right, bb.bottom) && inside(bb.x, bb.bottom)
            }
        }
    }
}
