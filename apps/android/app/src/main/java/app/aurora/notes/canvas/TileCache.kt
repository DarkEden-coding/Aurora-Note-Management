// Rasterised scene tiles. Each tile is a RenderNode drawn into its own GPU layer at a fixed
// scale, so panning only composites finished tiles and an edit re-renders only the tiles it touches.
package app.aurora.notes.canvas

import android.graphics.Canvas
import android.graphics.RenderNode
import app.aurora.notes.data.Bounds
import app.aurora.notes.data.CanvasObject
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.roundToInt

private const val TILE_PX = 512
private const val MAX_TILES = 96
/** Extra world margin so stroke caps and outlines that poke past bounds are not cut at tile edges. */
private const val INK_MARGIN = 12.0

/** Paints what lies under the objects (page sheets, patterns) for a world area at a given scale. */
fun interface UnderPainter {
    fun paint(canvas: Canvas, area: Bounds, scale: Double)
}

class TileCache(private val renderer: SceneRenderer) {
    var under: UnderPainter? = null

    private class Tile(val node: RenderNode, var dirty: Boolean, var lastUsed: Long)

    private val tiles = HashMap<Long, Tile>()
    private var tileScale = 0.0
    private var frame = 0L

    private fun key(tx: Int, ty: Int) = (tx.toLong() shl 32) or (ty.toLong() and 0xffffffffL)

    fun invalidateAll() { tiles.values.forEach { it.dirty = true } }

    /** Marks the tiles under a world rectangle for re-rendering. */
    fun invalidate(b: Bounds) {
        if (tileScale <= 0) return
        val size = TILE_PX / tileScale
        val x0 = floor((b.x - INK_MARGIN) / size).toInt(); val x1 = floor((b.right + INK_MARGIN) / size).toInt()
        val y0 = floor((b.y - INK_MARGIN) / size).toInt(); val y1 = floor((b.bottom + INK_MARGIN) / size).toInt()
        if ((x1 - x0 + 1).toLong() * (y1 - y0 + 1) > tiles.size) {
            for ((k, t) in tiles) { val tx = (k shr 32).toInt(); val ty = k.toInt(); if (tx in x0..x1 && ty in y0..y1) t.dirty = true }
        } else {
            for (tx in x0..x1) for (ty in y0..y1) tiles[key(tx, ty)]?.dirty = true
        }
    }

    /**
     * Draws the visible part of the scene in screen space. While `zooming`, existing tiles are
     * stretched rather than re-rendered; afterwards they are rebuilt sharp at the new scale.
     */
    fun draw(canvas: Canvas, camX: Double, camY: Double, scale: Double, viewW: Int, viewH: Int, zooming: Boolean, objects: List<CanvasObject>, excluded: Set<String>) {
        frame++
        if (tileScale <= 0 || (!zooming && abs(tileScale - scale) > 1e-9)) {
            tiles.values.forEach { it.node.discardDisplayList() }
            tiles.clear()
            tileScale = scale
        }
        val ratio = scale / tileScale
        val size = TILE_PX / tileScale
        val viewWorldW = viewW / scale; val viewWorldH = viewH / scale
        val tx0 = floor(camX / size).toInt(); val tx1 = floor((camX + viewWorldW) / size).toInt()
        val ty0 = floor(camY / size).toInt(); val ty1 = floor((camY + viewWorldH) / size).toInt()
        // Whole-pixel origin shared by every tile so neighbours never show seams.
        val originX = if (zooming) -camX * scale else (-camX * scale).roundToInt().toDouble()
        val originY = if (zooming) -camY * scale else (-camY * scale).roundToInt().toDouble()
        for (tx in tx0..tx1) for (ty in ty0..ty1) {
            val tile = tiles.getOrPut(key(tx, ty)) {
                Tile(RenderNode("tile").apply {
                    setPosition(0, 0, TILE_PX, TILE_PX)
                    setUseCompositingLayer(true, null)
                }, true, frame)
            }
            tile.lastUsed = frame
            // Android drops child display lists when the app is backgrounded or trimmed, so a "clean" tile may be empty.
            if (tile.dirty || !tile.node.hasDisplayList()) { record(tile.node, tx * size, ty * size, size, objects, excluded); tile.dirty = false }
            canvas.save()
            canvas.translate((originX + tx * TILE_PX * ratio).toFloat(), (originY + ty * TILE_PX * ratio).toFloat())
            if (zooming) canvas.scale(ratio.toFloat(), ratio.toFloat())
            canvas.drawRenderNode(tile.node)
            canvas.restore()
        }
        evict()
    }

    private fun record(node: RenderNode, wx: Double, wy: Double, size: Double, objects: List<CanvasObject>, excluded: Set<String>) {
        val area = Bounds(wx - INK_MARGIN, wy - INK_MARGIN, size + INK_MARGIN * 2, size + INK_MARGIN * 2)
        val c = node.beginRecording()
        try {
            c.scale(tileScale.toFloat(), tileScale.toFloat())
            c.translate(-wx.toFloat(), -wy.toFloat())
            c.save()
            c.clipRect(wx.toFloat(), wy.toFloat(), (wx + size).toFloat(), (wy + size).toFloat())
            under?.paint(c, Bounds(wx, wy, size, size), tileScale)
            c.restore()
            for (o in objects) if (o.bounds.intersects(area) && o.id !in excluded) renderer.draw(c, o)
        } finally {
            node.endRecording()
        }
    }

    private fun evict() {
        if (tiles.size <= MAX_TILES) return
        tiles.entries.sortedBy { it.value.lastUsed }.take(tiles.size - MAX_TILES).forEach {
            it.value.node.discardDisplayList()
            tiles.remove(it.key)
        }
    }

    fun clear() {
        tiles.values.forEach { it.node.discardDisplayList() }
        tiles.clear()
        tileScale = 0.0
    }
}
