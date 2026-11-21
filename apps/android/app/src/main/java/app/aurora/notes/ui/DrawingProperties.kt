// Drawing property panels, matching the web's DrawingProperties.tsx and DrawingColorPalette.tsx:
// the left-side placement panel for the active tool and the shared controls used for selected shapes.
package app.aurora.notes.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.aurora.notes.canvas.DrawingStyle
import app.aurora.notes.canvas.Tool
import kotlin.math.roundToInt

private const val MAX_COLORS = 64

/** The web's PlacementTool kinds, by the canvas tool that places them. */
internal fun placementKind(tool: Tool): String? = when (tool) {
    Tool.Pen -> "pen"; Tool.Highlighter -> "highlighter"
    Tool.Line -> "line"; Tool.Rectangle -> "rectangle"; Tool.Ellipse -> "ellipse"
    Tool.Arrow -> "arrow"; Tool.Matrix -> "matrix"
    else -> null
}

/** .drawing-properties-panel: the active tool's defaults, docked at the canvas's top left. */
@Composable
internal fun DrawingPlacementPanel(
    kind: String,
    style: DrawingStyle,
    palette: List<String>,
    onPaletteChange: (List<String>) -> Unit,
    onPreview: (DrawingStyle) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (kind == "pen") {
        // The pen panel is a narrow column of swatches with no title.
        Column(modifier.width(50.dp).panel(radius = Neo.radius + 2.dp).padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            ColorPalette(palette, style.strokeColor, vertical = true, onSelect = { onPreview(style.copy(strokeColor = it)) }, onChange = onPaletteChange)
        }
        return
    }
    val title = if (kind == "highlighter") "Highlighter" else "Shape"
    Column(modifier.width(292.dp).heightIn(max = 560.dp).panel(radius = Neo.radius + 2.dp).verticalScroll(rememberScrollState()).padding(16.dp)) {
        PropertiesTitle("$title properties")
        DrawingStyleControls(kind, style, palette, onPaletteChange, onPreview, onCommit = {})
    }
}

@Composable
internal fun PropertiesTitle(text: String) =
    Label(text, 15.sp, weight = FontWeight.SemiBold, modifier = Modifier.padding(bottom = 16.dp))

/**
 * Shared controls for placement defaults and a selected shape. [onPreview] shows a change at once;
 * [onCommit] ends an edit (slider release, or right after a tap).
 */
@Composable
internal fun DrawingStyleControls(
    kind: String,
    style: DrawingStyle,
    palette: List<String>,
    onPaletteChange: (List<String>) -> Unit,
    onPreview: (DrawingStyle) -> Unit,
    onCommit: () -> Unit,
) {
    val supportsFill = kind == "rectangle" || kind == "ellipse"
    var fillTarget by remember(supportsFill) { mutableStateOf(false) }
    val applyNow = { next: DrawingStyle -> onPreview(next); onCommit() }

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (supportsFill) OptionGroup(
            listOf("outline" to "Outline", "fill" to "Fill", "none" to "No fill"),
            selected = when { !fillTarget -> "outline"; style.fillColor == null -> "none"; else -> "fill" },
        ) { option ->
            when (option) {
                "outline" -> fillTarget = false
                "fill" -> fillTarget = true
                else -> { fillTarget = true; applyNow(style.copy(fillColor = null)) }
            }
        }

        ColorPalette(
            palette,
            selected = if (fillTarget) style.fillColor else style.strokeColor,
            vertical = false,
            onSelect = { applyNow(if (fillTarget) style.copy(fillColor = it) else style.copy(strokeColor = it)) },
            onChange = onPaletteChange,
        )

        if (supportsFill && style.fillColor != null) PropertySlider("Fill opacity", style.fillOpacity, 0.0..100.0, 1.0, "${style.fillOpacity.roundToInt()}%",
            onChange = { onPreview(style.copy(fillOpacity = it)) }, onDone = onCommit)

        if (kind == "highlighter") PropertySlider("Width", style.strokeWidth, 4.0..40.0, 1.0, "${style.strokeWidth.roundToInt()}px",
            onChange = { onPreview(style.copy(strokeWidth = it)) }, onDone = onCommit)

        if (kind != "pen" && kind != "highlighter") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Label("Line type", 12.sp, Neo.muted)
                OptionGroup(listOf("solid" to "Solid", "dashed" to "Dashed", "dotted" to "Dotted"), style.lineStyle) {
                    applyNow(style.copy(lineStyle = it))
                }
            }
            PropertySlider("Line width", style.strokeWidth, 1.0..12.0, 0.5, "${formatPx(style.strokeWidth)}px",
                onChange = { onPreview(style.copy(strokeWidth = it)) }, onDone = onCommit)
        }

        if (kind == "rectangle") PropertySlider("Corner radius", style.cornerRadius, 0.0..64.0, 1.0, "${style.cornerRadius.roundToInt()}",
            onChange = { onPreview(style.copy(cornerRadius = it)) }, onDone = onCommit)
    }
}

private fun formatPx(value: Double) = if (value % 1.0 == 0.0) value.toInt().toString() else value.toString()

/** .drawing-color-target: a sunken strip of equal buttons; the active one is accent-tinted. */
@Composable
private fun OptionGroup(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(9.dp)).background(Neo.surfaceSunken)
            .border(1.dp, Neo.border, RoundedCornerShape(9.dp)).padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        for ((value, label) in options) {
            val on = value == selected
            val shape = RoundedCornerShape(7.dp)
            var m = Modifier.weight(1f).heightIn(min = 34.dp).clip(shape)
            if (on) m = m.background(Neo.mix(Neo.accent, Neo.surfaceRaised, 0.13f)).border(1.dp, Neo.accent.copy(alpha = 0.72f), shape)
            Box(m.clickable { onSelect(value) }.padding(horizontal = 7.dp, vertical = 5.dp), contentAlignment = Alignment.Center) {
                Label(label, 12.sp, if (on) Neo.mix(Neo.accent, Color.White, 0.84f) else Neo.text)
            }
        }
    }
}

/** .drawing-property-field with a range input and its value readout. */
@Composable
private fun PropertySlider(
    label: String, value: Double, range: ClosedFloatingPointRange<Double>, step: Double, readout: String,
    onChange: (Double) -> Unit, onDone: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Label(label, 12.sp, Neo.muted)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            RangeInput(value, range, step, onChange, onDone, Modifier.weight(1f))
            Label(readout, 12.sp, modifier = Modifier.widthIn(min = 38.dp))
        }
    }
}

/** The web's range input: a 4dp rounded track and a 17dp accent thumb; tap or drag anywhere on it. */
@Composable
private fun RangeInput(
    value: Double, range: ClosedFloatingPointRange<Double>, step: Double,
    onChange: (Double) -> Unit, onDone: () -> Unit, modifier: Modifier,
) {
    val change by rememberUpdatedState(onChange)
    val done by rememberUpdatedState(onDone)
    val fraction = ((value - range.start) / (range.endInclusive - range.start)).toFloat().coerceIn(0f, 1f)
    val thumb = 17.dp
    fun valueAt(x: Float, width: Int, thumbPx: Float): Double {
        val t = ((x - thumbPx / 2) / (width - thumbPx)).coerceIn(0f, 1f)
        val raw = range.start + t * (range.endInclusive - range.start)
        return (Math.round(raw / step) * step).coerceIn(range.start, range.endInclusive)
    }
    Box(
        modifier.height(32.dp)
            .pointerInput(range, step) {
                detectTapGestures { change(valueAt(it.x, size.width, thumb.toPx())); done() }
            }
            .pointerInput(range, step) {
                detectHorizontalDragGestures(onDragEnd = { done() }, onDragCancel = { done() }) { input, _ ->
                    input.consume()
                    change(valueAt(input.position.x, size.width, thumb.toPx()))
                }
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(Modifier.fillMaxWidth().padding(horizontal = thumb / 2).height(4.dp).clip(CircleShape)
            .background(Neo.mix(Neo.border, Neo.surfaceSunken, 0.72f).copy(alpha = 1f))) {
            Box(Modifier.fillMaxWidth(fraction).height(4.dp).background(Neo.accent))
        }
        androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth()) {
            Box(Modifier.offset(x = (maxWidth - thumb) * fraction).size(thumb)
                .boxShadow(listOf(BoxShadow(0, 1, 5, Color.Black.copy(alpha = 0.34f))), thumb / 2).clip(CircleShape).background(Neo.accent))
        }
    }
}

/**
 * The account palette (.drawing-color-palette): tap a swatch to use it, long-press and drag to
 * reorder, the trash button to remove colors, and + to add one.
 */
@Composable
private fun ColorPalette(
    palette: List<String>,
    selected: String?,
    vertical: Boolean,
    onSelect: (String) -> Unit,
    onChange: (List<String>) -> Unit,
) {
    var editing by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val current by rememberUpdatedState(palette)
    val swatchBounds = remember { mutableStateMapOf<Int, Rect>() }
    var dragging by remember { mutableStateOf<Int?>(null) }

    Column(horizontalAlignment = if (vertical) Alignment.CenterHorizontally else Alignment.Start) {
        Row(Modifier.then(if (vertical) Modifier else Modifier.fillMaxWidth()).heightIn(min = 24.dp).padding(bottom = if (vertical) 8.dp else 9.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (!vertical) Label("Color", 12.sp, Neo.muted, modifier = Modifier.weight(1f))
            val shape = RoundedCornerShape(7.dp)
            Box(
                Modifier.heightIn(min = 26.dp).widthIn(min = 28.dp).clip(shape)
                    .background(if (editing) Neo.mix(Neo.accent, Neo.surfaceRaised, 0.13f) else Neo.surfaceRaised)
                    .border(1.dp, if (editing) Neo.accent.copy(alpha = 0.72f) else Neo.border, shape)
                    .clickable { editing = !editing; error = null }.padding(horizontal = 7.dp, vertical = 3.dp),
                contentAlignment = Alignment.Center,
            ) { if (editing) Label("Done", 11.sp) else LucideIcon(Lucide.Trash2, 14, Neo.muted) }
        }

        val items = palette.mapIndexed { index, color -> index to color }
        val rows = if (vertical) items.map { listOf(it) } else items.chunked(6)
        val addInRow = !editing && palette.size < MAX_COLORS
        Column(verticalArrangement = Arrangement.spacedBy(10.dp), horizontalAlignment = if (vertical) Alignment.CenterHorizontally else Alignment.Start) {
            for ((rowIndex, row) in rows.withIndex()) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for ((index, color) in row) {
                        Swatch(
                            color, on = selected.equals(color, ignoreCase = true), dragging = dragging == index, editing = editing,
                            canRemove = palette.size > 1,
                            modifier = Modifier.onGloballyPositioned { swatchBounds[index] = it.boundsInRoot() }
                                .pointerInput(editing) {
                                    if (editing) return@pointerInput
                                    var from = -1
                                    detectDragGesturesAfterLongPress(
                                        onDragStart = { from = index; dragging = index },
                                        onDragEnd = { dragging = null },
                                        onDragCancel = { dragging = null },
                                    ) { change, _ ->
                                        change.consume()
                                        val origin = swatchBounds[from] ?: return@detectDragGesturesAfterLongPress
                                        val point = origin.topLeft + change.position
                                        val to = swatchBounds.entries.firstOrNull { it.key < current.size && it.value.contains(point) }?.key ?: return@detectDragGesturesAfterLongPress
                                        if (to == from) return@detectDragGesturesAfterLongPress
                                        onChange(current.toMutableList().apply { add(to, removeAt(from)) })
                                        from = to; dragging = to
                                    }
                                },
                            onClick = { onSelect(color) },
                            onRemove = { onChange(palette.filterIndexed { i, _ -> i != index }) },
                        )
                    }
                    if (addInRow && !vertical && rowIndex == rows.lastIndex && row.size < 6) AddSwatch { error = null; adding = true }
                }
            }
            if (addInRow && (vertical || rows.isEmpty() || rows.last().size == 6)) AddSwatch { error = null; adding = true }
        }
        if (editing) Label("Tap × to remove a color.", 11.sp, Neo.muted, modifier = Modifier.padding(top = 8.dp))
        error?.let { Label(it, 11.sp, Neo.danger, modifier = Modifier.padding(top = 8.dp)) }
    }

    if (adding) ColorPickerDialog(onDismiss = { adding = false }) { color ->
        adding = false
        if (palette.any { it.equals(color, ignoreCase = true) }) error = "That color is already in the palette."
        else onChange(palette + color)
    }
}

@Composable
private fun Swatch(
    color: String, on: Boolean, dragging: Boolean, editing: Boolean, canRemove: Boolean,
    modifier: Modifier, onClick: () -> Unit, onRemove: () -> Unit,
) {
    Box(modifier.size(32.dp).drawBehind {
        // outline: 2px accent, offset 3px — drawn outside the swatch without changing layout.
        if (on) drawCircle(Neo.accent, radius = size.minDimension / 2 + 4.dp.toPx(), style = Stroke(2.dp.toPx()))
    }) {
        Box(Modifier.fillMaxSize().scale(if (dragging) 1.12f else 1f).clip(CircleShape).background(parseHex(color))
            .insetShadow(listOf(BoxShadow(0, 1, 3, Color.Black.copy(alpha = 0.45f))), 16.dp)
            .border(2.dp, Neo.mix(Neo.border, Color.White, 0.91f).copy(alpha = 0.16f), CircleShape)
            .then(if (editing) Modifier else Modifier.clickable(onClick = onClick)))
        if (editing) Box(
            Modifier.align(Alignment.TopEnd).offset(5.dp, (-5).dp).size(18.dp).clip(CircleShape)
                .background(Neo.surfaceRaised).border(1.dp, Neo.danger.copy(alpha = 0.7f), CircleShape)
                .then(if (canRemove) Modifier.clickable(onClick = onRemove) else Modifier),
            contentAlignment = Alignment.Center,
        ) { LucideIcon(Lucide.X, 11, if (canRemove) Neo.danger else Neo.muted) }
    }
}

@Composable
private fun AddSwatch(onClick: () -> Unit) {
    Box(
        Modifier.size(32.dp).clip(CircleShape).background(Neo.surfaceSunken).dashed(Neo.border.copy(alpha = 0.2f), 16.dp).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { LucideIcon(Lucide.Plus, 17, Neo.muted) }
}

private fun Modifier.dashed(color: Color, radius: Dp) = drawBehind {
    val r = radius.toPx()
    drawRoundRect(color, cornerRadius = androidx.compose.ui.geometry.CornerRadius(r, r),
        style = Stroke(width = 2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 5f))))
}

internal fun parseHex(value: String): Color =
    runCatching { Color(android.graphics.Color.parseColor(value)) }.getOrDefault(Color.Black)

/** Stand-in for the browser's native color input: hue, saturation and brightness, plus a hex field. */
@Composable
private fun ColorPickerDialog(onDismiss: () -> Unit, onPick: (String) -> Unit) {
    // Starts at the web input's default, #738cff.
    val start = remember { FloatArray(3).also { android.graphics.Color.colorToHSV(0xFF738CFF.toInt(), it) } }
    var hue by remember { mutableStateOf(start[0]) }
    var sat by remember { mutableStateOf(start[1]) }
    var value by remember { mutableStateOf(start[2]) }
    val argb = android.graphics.Color.HSVToColor(floatArrayOf(hue, sat, value))
    val hex = String.format("#%06x", argb and 0xFFFFFF)

    NeoDialog(onDismiss) {
        DialogHeader("Palette", "Add color", onDismiss)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Box(Modifier.size(64.dp).clip(CircleShape).background(Color(argb)).border(2.dp, Neo.border, CircleShape))
            Label(hex, 16.sp, weight = FontWeight.SemiBold)
        }
        GradientSlider("Hue", hue, 0f..360f, (0..6).map { Color(android.graphics.Color.HSVToColor(floatArrayOf(it * 60f, 1f, 1f))) }) { hue = it }
        GradientSlider("Saturation", sat, 0f..1f, listOf(
            Color(android.graphics.Color.HSVToColor(floatArrayOf(hue, 0f, value))),
            Color(android.graphics.Color.HSVToColor(floatArrayOf(hue, 1f, value))),
        )) { sat = it }
        GradientSlider("Brightness", value, 0f..1f, listOf(Color.Black, Color(android.graphics.Color.HSVToColor(floatArrayOf(hue, sat, 1f))))) { value = it }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            NeoButton(fill = Color.Transparent, shadow = false, onClick = onDismiss) { Label("Cancel") }
            NeoButton(fill = Neo.accent, onClick = { onPick(hex) }) { Label("Add", color = Neo.accentContrast) }
        }
    }
}

/** A slider drawn over a gradient track, for picking a color channel. */
@Composable
private fun GradientSlider(label: String, value: Float, range: ClosedFloatingPointRange<Float>, track: List<Color>, onChange: (Float) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Label(label, 12.sp, Neo.muted)
        Box(contentAlignment = Alignment.Center) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 10.dp).height(10.dp).clip(CircleShape)
                .background(androidx.compose.ui.graphics.Brush.horizontalGradient(track)))
            Slider(
                value, onChange, valueRange = range,
                colors = SliderDefaults.colors(thumbColor = Color.White, activeTrackColor = Color.Transparent, inactiveTrackColor = Color.Transparent),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
