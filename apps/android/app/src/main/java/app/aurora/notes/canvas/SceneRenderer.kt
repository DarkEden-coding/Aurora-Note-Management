// Draws canvas objects with android.graphics, matching the web renderer (ObjectRenderer.tsx).
// Prepared paths are cached per object instance so redraws never rebuild geometry.
package app.aurora.notes.canvas

import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import app.aurora.notes.data.CanvasObject
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private const val PRESSURE_STEPS = 32

private class Prepared(val source: CanvasObject, val draw: (Canvas) -> Unit)

class SceneRenderer {
    private val cache = HashMap<String, Prepared>()
    private val samplesCache = HashMap<String, Pair<CanvasObject, StrokeSamples>>()

    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val placeholderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1f
        color = 0x55FFFFFF
    }
    private val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x99FFFFFF.toInt(); textSize = 12f }

    /** Stroke samples, parsed once per object instance. */
    fun samples(o: CanvasObject): StrokeSamples {
        val hit = samplesCache[o.id]
        if (hit != null && hit.first === o) return hit.second
        val parsed = o.strokeSamples()
        samplesCache[o.id] = o to parsed
        return parsed
    }

    fun draw(canvas: Canvas, o: CanvasObject) {
        val hit = cache[o.id]
        val prepared = if (hit != null && hit.source === o) hit else prepare(o).also { cache[o.id] = it }
        prepared.draw(canvas)
    }

    /** Drops cached geometry for objects that no longer exist. */
    fun retain(ids: Set<String>) {
        cache.keys.retainAll(ids)
        samplesCache.keys.retainAll(ids)
    }

    private fun dash(o: CanvasObject, width: Float): DashPathEffect? = when (o.lineStyle) {
        "dashed" -> DashPathEffect(floatArrayOf(width * 4, width * 3), 0f)
        "dotted" -> DashPathEffect(floatArrayOf(0.001f, width * 2.5f), 0f)
        else -> null
    }

    private fun outline(o: CanvasObject, cap: Paint.Cap = Paint.Cap.BUTT): Paint {
        val width = o.shapeStrokeWidth.toFloat()
        return Paint(strokePaint).apply {
            color = parseColor(o.shapeColor)
            strokeWidth = width
            pathEffect = dash(o, width)
            strokeCap = if (o.lineStyle == "dotted") Paint.Cap.ROUND else cap
            strokeJoin = Paint.Join.MITER
        }
    }

    private fun fill(o: CanvasObject): Paint? {
        val fill = o.shapeFill ?: return null
        return Paint(fillPaint).apply {
            color = parseColor(fill)
            alpha = (o.shapeFillOpacity / 100 * 255).roundToInt()
        }
    }

    private fun prepare(o: CanvasObject): Prepared {
        val b = o.bounds
        return when (o.kind) {
            "stroke" -> prepareStroke(o)
            "rectangle" -> {
                val rect = RectF(b.x.toFloat(), b.y.toFloat(), b.right.toFloat(), b.bottom.toFloat())
                val r = min(o.cornerRadius, min(b.width / 2, b.height / 2)).toFloat()
                val line = outline(o); val area = fill(o)
                Prepared(o) { c -> area?.let { c.drawRoundRect(rect, r, r, it) }; c.drawRoundRect(rect, r, r, line) }
            }
            "ellipse" -> {
                val rect = RectF(b.x.toFloat(), b.y.toFloat(), b.right.toFloat(), b.bottom.toFloat())
                val line = outline(o); val area = fill(o)
                Prepared(o) { c -> area?.let { c.drawOval(rect, it) }; c.drawOval(rect, line) }
            }
            "line" -> {
                val (s, e) = o.lineEndpoints()
                val line = outline(o, Paint.Cap.ROUND)
                Prepared(o) { c -> c.drawLine(s.x.toFloat(), s.y.toFloat(), e.x.toFloat(), e.y.toFloat(), line) }
            }
            "arrow" -> {
                val (s, e) = o.lineEndpoints()
                val (w1, w2) = arrowWings(s, e)
                val line = outline(o, Paint.Cap.ROUND)
                val head = Path().apply {
                    moveTo(e.x.toFloat(), e.y.toFloat()); lineTo(w1.x.toFloat(), w1.y.toFloat())
                    lineTo(w2.x.toFloat(), w2.y.toFloat()); close()
                }
                val headPaint = Paint(fillPaint).apply { color = parseColor(o.shapeColor) }
                Prepared(o) { c ->
                    c.drawLine(s.x.toFloat(), s.y.toFloat(), e.x.toFloat(), e.y.toFloat(), line)
                    c.drawPath(head, headPaint)
                }
            }
            "matrix" -> {
                val arm = min(b.width / 2, min(24.0, max(4.0, b.height / 10))).toFloat()
                val x = b.x.toFloat(); val y = b.y.toFloat(); val r = b.right.toFloat(); val btm = b.bottom.toFloat()
                val path = Path().apply {
                    moveTo(x + arm, y); lineTo(x, y); lineTo(x, btm); lineTo(x + arm, btm)
                    moveTo(r - arm, y); lineTo(r, y); lineTo(r, btm); lineTo(r - arm, btm)
                }
                val line = outline(o, Paint.Cap.SQUARE)
                Prepared(o) { c -> c.drawPath(path, line) }
            }
            else -> {
                // Rich text, images, PDFs, and practice cards are drawn by their own layers.
                val rect = RectF(b.x.toFloat(), b.y.toFloat(), b.right.toFloat(), b.bottom.toFloat())
                Prepared(o) { c -> c.drawRect(rect, placeholderPaint); c.drawText(o.kind, rect.left + 6, rect.top + 16, labelPaint) }
            }
        }
    }

    private fun prepareStroke(o: CanvasObject): Prepared {
        val s = samples(o)
        val color = parseColor(o.strokeColor)
        val base = o.strokeBaseWidth.toFloat()
        if (s.size == 0) return Prepared(o) {}
        if (o.isHighlighter) {
            val path = Path().apply {
                moveTo(s.x(0), s.y(0))
                for (i in 1 until s.size) lineTo(s.x(i), s.y(i))
                if (s.size == 1) lineTo(s.x(0) + 0.01f, s.y(0))
            }
            val paint = Paint(strokePaint).apply {
                this.color = color
                alpha = (HIGHLIGHTER_OPACITY * 255).roundToInt()
                strokeWidth = base
            }
            return Prepared(o) { c -> c.drawPath(path, paint) }
        }
        // Group segments by quantised pressure, exactly like the web's pressureStrokePaths.
        val groups = HashMap<Int, Path>()
        for (i in 1 until s.size) {
            val level = (s.p(i - 1).coerceIn(0f, 1f) * PRESSURE_STEPS).roundToInt()
            groups.getOrPut(level) { Path() }.apply { moveTo(s.x(i - 1), s.y(i - 1)); lineTo(s.x(i), s.y(i)) }
        }
        if (s.size == 1) {
            val level = (s.p(0).coerceIn(0f, 1f) * PRESSURE_STEPS).roundToInt()
            groups[level] = Path().apply { moveTo(s.x(0), s.y(0)); lineTo(s.x(0) + 0.01f, s.y(0)) }
        }
        val parts = groups.map { (level, path) ->
            path to Paint(strokePaint).apply {
                this.color = color
                strokeWidth = max(0.5f, base * (0.3f + level.toFloat() / PRESSURE_STEPS))
            }
        }
        return Prepared(o) { c -> for ((path, paint) in parts) c.drawPath(path, paint) }
    }

    companion object {
        /** Width of a pen segment for a pressure, as the web renders it. */
        fun pressureWidth(base: Float, pressure: Float): Float {
            val level = (pressure.coerceIn(0f, 1f) * PRESSURE_STEPS).roundToInt()
            return max(0.5f, base * (0.3f + level.toFloat() / PRESSURE_STEPS))
        }
    }
}
