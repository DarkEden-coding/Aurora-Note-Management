// Aurora's "neomorphic" theme for Compose: the web's tokens.css values plus CSS-style outer
// and inset box shadows, so panels, buttons and wells carry the same raised and pressed depth.
package app.aurora.notes.ui

import android.graphics.BlurMaskFilter
import android.graphics.Path
import android.graphics.RectF
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.hypot
import kotlin.math.max

/** Roboto at the exact weights the web app renders on Android, independent of the OEM default font. */
@OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)
val AuroraFont = androidx.compose.ui.text.font.FontFamily(
    listOf(400, 500, 600, 650, 700, 750, 800).map { w ->
        androidx.compose.ui.text.font.Font(
            app.aurora.notes.R.font.roboto,
            androidx.compose.ui.text.font.FontWeight(w),
            variationSettings = androidx.compose.ui.text.font.FontVariation.Settings(androidx.compose.ui.text.font.FontVariation.weight(w)),
        )
    },
)

object Neo {
    val bg = Color(0xFF151820)
    val bgRaised = Color(0xFF1D212B)
    val surface = Color(0xFF1A1E27)
    val surfaceRaised = Color(0xFF222733)
    val surfaceSunken = Color(0xFF12151C)
    val border = Color.White.copy(alpha = 0.065f)
    val text = Color(0xFFF1F3F8)
    val muted = Color(0xFF9FA7B8)
    val accent = Color(0xFF6C9EFF)
    val accentContrast = Color(0xFF07101F)
    val toolActiveInk = Color(0xFF14161A)
    val danger = Color(0xFFFF7D87)
    val success = Color(0xFF6FE09A)
    val radius = 16.dp

    /** The canvas viewport: color-mix(bg 78%, surface-sunken). */
    val viewport = mix(bg, surfaceSunken, 0.78f)

    // --shadow-outset / --shadow-inset and the larger shell shadow used by sidebar, topbar and canvas.
    val outset = listOf(BoxShadow(9, 9, 18, Color(5, 7, 11, (0.72f * 255).toInt())), BoxShadow(-7, -7, 16, Color.White.copy(alpha = 0.035f)))
    val inset = listOf(BoxShadow(4, 4, 9, Color(3, 5, 9, (0.64f * 255).toInt())), BoxShadow(-3, -3, 8, Color.White.copy(alpha = 0.035f)))
    val shell = listOf(BoxShadow(14, 14, 28, Color(4, 6, 10, (0.8f * 255).toInt())), BoxShadow(-9, -9, 22, Color.White.copy(alpha = 0.055f)))
    val floating = listOf(BoxShadow(0, 10, 28, Color.Black.copy(alpha = 0.28f)))

    fun mix(a: Color, b: Color, aWeight: Float) = Color(
        a.red * aWeight + b.red * (1 - aWeight),
        a.green * aWeight + b.green * (1 - aWeight),
        a.blue * aWeight + b.blue * (1 - aWeight),
        a.alpha * aWeight + b.alpha * (1 - aWeight),
    )
}

/** One CSS box-shadow layer, in dp. */
data class BoxShadow(val dx: Int, val dy: Int, val blur: Int, val color: Color)

/** CSS blur radius B is a Gaussian with sigma B/2; BlurMaskFilter takes a radius of about sigma / 0.57735. */
private fun DrawScope.blurRadius(blurDp: Int): Float = max(0.5f, (blurDp.dp.toPx() / 2f) / 0.57735f)

private fun roundRect(scope: DrawScope, radius: Dp, inset: Float = 0f) = Path().apply {
    val r = with(scope) { radius.toPx() }
    addRoundRect(RectF(inset, inset, scope.size.width - inset, scope.size.height - inset), r, r, Path.Direction.CW)
}

/**
 * Draws CSS-like outer box shadows behind the element. As in CSS, nothing is painted under
 * the element itself, so translucent surfaces show the background rather than their shadow.
 */
fun Modifier.boxShadow(shadows: List<BoxShadow>, radius: Dp = Neo.radius): Modifier = drawBehind {
    val canvas = drawContext.canvas.nativeCanvas
    val shape = roundRect(this, radius)
    canvas.save()
    canvas.clipOutPath(shape)
    for (s in shadows) {
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            color = s.color.toArgb()
            maskFilter = BlurMaskFilter(blurRadius(s.blur), BlurMaskFilter.Blur.NORMAL)
        }
        canvas.save()
        canvas.translate(s.dx.dp.toPx(), s.dy.dp.toPx())
        canvas.drawPath(shape, paint)
        canvas.restore()
    }
    canvas.restore()
}

/** CSS `box-shadow: inset ...`: a blurred shadow cast inward from the element's edges, drawn over its background. */
fun Modifier.insetShadow(shadows: List<BoxShadow>, radius: Dp = Neo.radius): Modifier = drawWithContent {
    val canvas = drawContext.canvas.nativeCanvas
    val shape = roundRect(this, radius)
    canvas.save()
    canvas.clipPath(shape)
    for (s in shadows) {
        val spread = s.blur.dp.toPx() * 2 + 4
        // A frame around the shape: everything outside it, offset so the blur bleeds in from one side.
        val frame = Path().apply {
            fillType = Path.FillType.EVEN_ODD
            addRect(-spread, -spread, size.width + spread, size.height + spread, Path.Direction.CW)
            addPath(shape)
            offset(s.dx.dp.toPx(), s.dy.dp.toPx())
        }
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            color = s.color.toArgb()
            maskFilter = BlurMaskFilter(blurRadius(s.blur), BlurMaskFilter.Blur.NORMAL)
        }
        canvas.drawPath(frame, paint)
    }
    canvas.restore()
    drawContent()
}

/** A raised neomorphic panel: surface fill, hairline border, outset shadow. */
fun Modifier.panel(
    shadows: List<BoxShadow> = Neo.outset,
    radius: Dp = Neo.radius,
    fill: Color = Neo.surface,
    border: Color = Neo.border,
): Modifier {
    val shape = RoundedCornerShape(radius)
    return this.boxShadow(shadows, radius).clip(shape).background(fill).border(1.dp, border, shape)
}

/** A pressed-in well (inputs, selected rows): sunken fill, hairline border, inset shadow. */
fun Modifier.well(radius: Dp = Neo.radius, fill: Color = Neo.surfaceSunken, border: Color = Neo.border): Modifier {
    val shape = RoundedCornerShape(radius)
    return this.clip(shape).background(fill).insetShadow(Neo.inset, radius).border(1.dp, border, shape)
}

/** body background: radial-gradient(circle at 48% -20%, #242a38 0, #151820 45%, #11131a 100%). */
@Composable
fun AppBackground(modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        val w = constraints.maxWidth.toFloat()
        val h = constraints.maxHeight.toFloat()
        val center = Offset(w * 0.48f, -0.2f * h)
        // "circle" defaults to farthest-corner sizing.
        val radius = maxOf(hypot(center.x, h - center.y), hypot(w - center.x, h - center.y))
        val brush = Brush.radialGradient(
            0f to Color(0xFF242A38), 0.45f to Color(0xFF151820), 1f to Color(0xFF11131A),
            center = center, radius = radius,
        )
        androidx.compose.foundation.layout.Box(Modifier.fillMaxSize().background(brush))
    }
}
