// Reads and writes canvas object payloads using the same conventions and fallbacks as the web client (features/canvas/objects.ts).
package app.aurora.notes.canvas

import android.graphics.Color
import app.aurora.notes.data.Bounds
import app.aurora.notes.data.CanvasObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.time.Instant

data class Pt(val x: Double, val y: Double)

/** Stroke samples packed as x, y, pressure triples. */
class StrokeSamples(val data: FloatArray) {
    val size get() = data.size / 3
    fun x(i: Int) = data[i * 3]
    fun y(i: Int) = data[i * 3 + 1]
    fun p(i: Int) = data[i * 3 + 2]
}

private fun JsonObject.num(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull?.takeIf { it.isFinite() }
private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

fun CanvasObject.strokeSamples(): StrokeSamples {
    val raw = payload["points"] as? JsonArray ?: return StrokeSamples(FloatArray(0))
    val out = FloatArray(raw.size * 3)
    var n = 0
    for (entry in raw) {
        val triple = entry as? JsonArray ?: continue
        if (triple.size < 3) continue
        val x = (triple[0] as? JsonPrimitive)?.doubleOrNull ?: continue
        val y = (triple[1] as? JsonPrimitive)?.doubleOrNull ?: continue
        val p = (triple[2] as? JsonPrimitive)?.doubleOrNull ?: continue
        out[n++] = x.toFloat(); out[n++] = y.toFloat(); out[n++] = p.toFloat()
    }
    return StrokeSamples(if (n == out.size) out else out.copyOf(n))
}

val CanvasObject.isHighlighter get() = kind == "stroke" && (payload["highlighter"] as? JsonPrimitive)?.booleanOrNull == true
val CanvasObject.strokeColor get() = payload.str("color") ?: "#e6e8ec"
val CanvasObject.strokeBaseWidth get() = payload.num("baseWidth")?.takeIf { it > 0 } ?: 2.5
val CanvasObject.shapeStrokeWidth get() = payload.num("strokeWidth")?.takeIf { it > 0 } ?: 2.0
val CanvasObject.shapeColor get() = payload.str("color") ?: "#e6e8ec"
val CanvasObject.shapeFill get() = payload.str("fill")
val CanvasObject.shapeFillOpacity get() = (payload.num("fillOpacity") ?: 100.0).coerceIn(0.0, 100.0)
val CanvasObject.lineStyle get() = payload.str("lineStyle")?.takeIf { it == "dashed" || it == "dotted" } ?: "solid"
val CanvasObject.cornerRadius get() = (payload.num("cornerRadius") ?: 2.0).coerceIn(0.0, 64.0)

const val HIGHLIGHTER_OPACITY = 0.38f

private fun JsonElement?.point(): Pt? {
    val o = this as? JsonObject ?: return null
    val x = o.num("x") ?: return null
    val y = o.num("y") ?: return null
    return Pt(x, y)
}

/** Line/arrow endpoints, with the web client's fallback for legacy objects. */
fun CanvasObject.lineEndpoints(): Pair<Pt, Pt> {
    val start = payload["start"].point()
    val end = payload["end"].point()
    if (start != null && end != null) return start to end
    val b = bounds
    return if (kind == "line") Pt(b.x, b.y + b.height / 2) to Pt(b.right, b.y + b.height / 2)
    else Pt(b.x, b.y) to Pt(b.right, b.bottom)
}

fun arrowWings(start: Pt, end: Pt): Pair<Pt, Pt> {
    val length = Math.hypot(end.x - start.x, end.y - start.y)
    val head = (length / 4).coerceIn(8.0, 18.0)
    val angle = Math.atan2(end.y - start.y, end.x - start.x)
    val spread = Math.PI / 7
    return Pt(end.x - head * Math.cos(angle - spread), end.y - head * Math.sin(angle - spread)) to
        Pt(end.x - head * Math.cos(angle + spread), end.y - head * Math.sin(angle + spread))
}

fun parseColor(value: String, fallback: Int = Color.WHITE): Int = runCatching { Color.parseColor(value) }.getOrDefault(fallback)

fun nowIso(): String = Instant.now().toString()

fun pointsPayload(samples: FloatArray, color: String, baseWidth: Double, highlighter: Boolean): JsonObject {
    val points = ArrayList<JsonElement>(samples.size / 3)
    for (i in 0 until samples.size / 3) {
        points.add(JsonArray(listOf(JsonPrimitive(samples[i * 3]), JsonPrimitive(samples[i * 3 + 1]), JsonPrimitive(samples[i * 3 + 2]))))
    }
    val fields = mutableMapOf<String, JsonElement>(
        "points" to JsonArray(points),
        "color" to JsonPrimitive(color),
        "baseWidth" to JsonPrimitive(baseWidth),
    )
    if (highlighter) fields["highlighter"] = JsonPrimitive(true)
    return JsonObject(fields)
}

fun pointJson(p: Pt) = JsonObject(mapOf("x" to JsonPrimitive(p.x), "y" to JsonPrimitive(p.y)))

/** Moves an object to new bounds, carrying stroke points and line endpoints with it. */
fun CanvasObject.movedTo(target: Bounds): CanvasObject {
    val dx = target.x - bounds.x
    val dy = target.y - bounds.y
    val newPayload = when (kind) {
        "stroke" -> {
            val raw = payload["points"] as? JsonArray
            if (raw == null) payload else JsonObject(payload + ("points" to JsonArray(raw.map { entry ->
                val t = entry as? JsonArray
                val x = (t?.getOrNull(0) as? JsonPrimitive)?.doubleOrNull
                val y = (t?.getOrNull(1) as? JsonPrimitive)?.doubleOrNull
                if (t == null || x == null || y == null) entry
                else JsonArray(listOf(JsonPrimitive(x + dx), JsonPrimitive(y + dy)) + t.drop(2))
            })))
        }
        "line", "arrow" -> {
            val s = payload["start"].point()
            val e = payload["end"].point()
            if (s == null || e == null) payload
            else JsonObject(payload + mapOf(
                "start" to pointJson(Pt(s.x + dx, s.y + dy)),
                "end" to pointJson(Pt(e.x + dx, e.y + dy)),
            ))
        }
        else -> payload
    }
    return copy(bounds = target, payload = newPayload)
}

