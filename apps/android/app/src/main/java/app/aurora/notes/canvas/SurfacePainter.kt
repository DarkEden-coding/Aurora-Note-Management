// Paints the writing surface under the content, matching the web canvas: neomorphic page sheets
// (fill, pattern, hairline border, raised shadows) that scale with zoom, or an infinite patterned plane.
package app.aurora.notes.canvas

import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import app.aurora.notes.data.Background
import app.aurora.notes.data.Bounds
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** How far page shadows reach beyond a sheet, in world units. */
const val SURFACE_SHADOW_REACH = 80.0

private const val PAGE_RADIUS = 16f * 0.55f

class SurfacePainter(private val density: Float) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val pattern = Paint(Paint.ANTI_ALIAS_FLAG).apply { strokeCap = Paint.Cap.ROUND }
    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = 0x17FFFFFF; strokeWidth = 1f }
    private val highlight = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = 0x09FFFFFF; strokeWidth = 1f }
    private val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF9FA7B8.toInt(); textSize = 10f; letterSpacing = 0.04f }
    // The web's neomorphic .canvas-page-frame shadows, in world units because the frame zooms with the page.
    private val darkShadow = shadowPaint(0xD1030509.toInt(), 34f)
    private val lightShadow = shadowPaint(0x0EFFFFFF, 26f)

    private fun shadowPaint(color: Int, cssBlur: Float) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        maskFilter = BlurMaskFilter(max(0.5f, (cssBlur / 2f) / 0.57735f), BlurMaskFilter.Blur.NORMAL)
    }

    /**
     * Draws the surfaces that intersect a world area onto a canvas already in world units.
     * `scale` is screen pixels per world unit, used to keep infinite-canvas dots a fixed screen size.
     */
    fun paint(canvas: Canvas, area: Bounds, frames: List<Bounds>, infinite: Boolean, background: Background, pageLabels: Boolean, scale: Double) {
        fill.color = parseColor(background.color)
        pattern.color = parseColor(background.patternColor)
        if (infinite) {
            canvas.drawRect(area.x.toFloat(), area.y.toFloat(), area.right.toFloat(), area.bottom.toFloat(), fill)
            // The infinite background is drawn in screen space on the web: dots and lines keep their pixel size.
            drawPattern(canvas, area, background, (density / scale).toFloat())
            return
        }
        frames.forEachIndexed { index, frame ->
            if (!frame.intersects(area.copy(x = area.x - SURFACE_SHADOW_REACH, y = area.y - SURFACE_SHADOW_REACH,
                    width = area.width + SURFACE_SHADOW_REACH * 2, height = area.height + SURFACE_SHADOW_REACH * 2))) return@forEachIndexed
            val rect = RectF(frame.x.toFloat(), frame.y.toFloat(), frame.right.toFloat(), frame.bottom.toFloat())
            canvas.save(); canvas.translate(18f, 18f); canvas.drawRoundRect(rect, PAGE_RADIUS, PAGE_RADIUS, darkShadow); canvas.restore()
            canvas.save(); canvas.translate(-10f, -10f); canvas.drawRoundRect(rect, PAGE_RADIUS, PAGE_RADIUS, lightShadow); canvas.restore()
            canvas.drawRoundRect(rect, PAGE_RADIUS, PAGE_RADIUS, fill)
            canvas.save()
            canvas.clipRect(rect)
            val visible = Bounds(max(area.x, frame.x), max(area.y, frame.y),
                max(0.0, min(area.right, frame.right) - max(area.x, frame.x)), max(0.0, min(area.bottom, frame.bottom) - max(area.y, frame.y)))
            drawPattern(canvas, visible, background, 1f)
            canvas.restore()
            val inner = RectF(rect).apply { inset(1f, 1f) }
            canvas.drawRoundRect(inner, PAGE_RADIUS, PAGE_RADIUS, highlight)
            canvas.drawRoundRect(rect, PAGE_RADIUS, PAGE_RADIUS, border)
            if (pageLabels) canvas.drawText("Page ${index + 1}", rect.left, rect.top - 18f + 10f, label)
        }
    }

    /** CSS pattern tiles anchored at the world origin; `px` is one CSS pixel in world units. */
    private fun drawPattern(canvas: Canvas, area: Bounds, bg: Background, px: Float) {
        val spacing = bg.spacing
        if (area.width <= 0 || area.height <= 0 || spacing / px < 3) return
        val firstX = floor(area.x / spacing) * spacing
        val firstY = floor(area.y / spacing) * spacing
        when (bg.pattern) {
            "dot-grid" -> {
                // radial-gradient(circle, color 1px, transparent 1.5px), centred in each cell.
                pattern.strokeWidth = 2.5f * px
                val cols = ((area.right - firstX) / spacing).toInt() + 1
                val rows = ((area.bottom - firstY) / spacing).toInt() + 1
                if (cols.toLong() * rows > 60_000) return
                val pts = FloatArray(cols * rows * 2)
                var n = 0
                for (r in 0 until rows) for (c in 0 until cols) {
                    pts[n++] = (firstX + c * spacing + spacing / 2).toFloat()
                    pts[n++] = (firstY + r * spacing + spacing / 2).toFloat()
                }
                canvas.drawPoints(pts, pattern)
            }
            "ruled", "square-grid" -> {
                pattern.strokeWidth = px
                var y = firstY
                while (y <= area.bottom) {
                    canvas.drawLine(area.x.toFloat(), (y + px / 2).toFloat(), area.right.toFloat(), (y + px / 2).toFloat(), pattern)
                    y += spacing
                }
                if (bg.pattern == "square-grid") {
                    var x = firstX
                    while (x <= area.right) {
                        canvas.drawLine((x + px / 2).toFloat(), area.y.toFloat(), (x + px / 2).toFloat(), area.bottom.toFloat(), pattern)
                        x += spacing
                    }
                }
            }
        }
    }
}
