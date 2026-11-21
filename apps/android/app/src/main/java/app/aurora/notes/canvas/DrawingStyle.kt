// Placement defaults and editable properties for pens and vector shapes, matching the web's DrawingStyle.
package app.aurora.notes.canvas

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import app.aurora.notes.data.CanvasObject

data class DrawingStyle(
    val strokeColor: String = "#000000",
    val fillColor: String? = null,
    /** Fill opacity as a percentage. */
    val fillOpacity: Double = 100.0,
    val strokeWidth: Double = 2.0,
    val lineStyle: String = "solid",
    val cornerRadius: Double = 2.0,
)

val VECTOR_KINDS = setOf("rectangle", "ellipse", "line", "arrow", "matrix")

fun CanvasObject.drawingStyle() = DrawingStyle(
    strokeColor = shapeColor,
    fillColor = shapeFill,
    fillOpacity = shapeFillOpacity,
    strokeWidth = shapeStrokeWidth,
    lineStyle = lineStyle,
    cornerRadius = cornerRadius,
)

/** Shape payload fields for [kind], as the web writes them on creation. */
fun DrawingStyle.payloadFor(kind: String): Map<String, JsonElement> = buildMap {
    put("color", JsonPrimitive(strokeColor))
    put("strokeWidth", JsonPrimitive(strokeWidth))
    put("lineStyle", JsonPrimitive(lineStyle))
    if (kind == "rectangle" || kind == "ellipse") {
        put("fill", fillColor?.let { JsonPrimitive(it) } ?: JsonNull)
        put("fillOpacity", JsonPrimitive(fillOpacity))
    }
    if (kind == "rectangle") put("cornerRadius", JsonPrimitive(cornerRadius))
}

/** [this] object restyled with [style], keeping its geometry and other payload fields. */
fun CanvasObject.restyled(style: DrawingStyle): CanvasObject =
    copy(payload = JsonObject(payload + style.payloadFor(kind)))
