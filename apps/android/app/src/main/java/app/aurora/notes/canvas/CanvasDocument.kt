// The open note's objects plus undo/redo. Every local edit is reported once through onCommit for syncing.
package app.aurora.notes.canvas

import app.aurora.notes.data.Bounds
import app.aurora.notes.data.CanvasObject

class CanvasDocument(
    val noteId: String,
    val ownerId: String,
    private val onCommit: (upserts: List<CanvasObject>, deletes: List<CanvasObject>) -> Unit,
) {
    private class Entry(val before: List<CanvasObject>, val after: List<CanvasObject>)

    private val byId = LinkedHashMap<String, CanvasObject>()
    private var sortedCache: List<CanvasObject>? = null
    private val undoStack = ArrayDeque<Entry>()
    private val redoStack = ArrayDeque<Entry>()
    var version = 0
        private set
    var listener: (() -> Unit)? = null

    /** World areas changed since the view last drew them; dirtyAll means everything. */
    val dirty = ArrayList<Bounds>()
    var dirtyAll = true

    /** Objects in paint order (lowest zIndex first). */
    val sorted: List<CanvasObject>
        get() = sortedCache ?: byId.values.sortedBy { it.zIndex }.also { sortedCache = it }

    val all: Collection<CanvasObject> get() = byId.values

    operator fun get(id: String) = byId[id]

    val canUndo get() = undoStack.isNotEmpty()
    val canRedo get() = redoStack.isNotEmpty()

    fun nextZIndex(): Int = (byId.values.maxOfOrNull { it.zIndex } ?: 0) + 1

    private fun changed() {
        sortedCache = null
        version++
        listener?.invoke()
    }

    /** Replaces the working set without recording history (initial load, server refresh). */
    fun load(objects: Collection<CanvasObject>) {
        byId.clear()
        objects.forEach { byId[it.id] = it }
        dirtyAll = true
        changed()
    }

    /** Applies server changes, leaving objects in the protected set untouched. */
    fun applyRemote(objects: List<CanvasObject>, deletedIds: List<String>, protectedIds: Set<String>) {
        var any = false
        for (o in objects) {
            if (o.id in protectedIds) continue
            val current = byId[o.id]
            if (current == null || o.revision >= current.revision) {
                current?.let { dirty += it.bounds }
                dirty += o.bounds
                byId[o.id] = o; any = true
            }
        }
        for (id in deletedIds) if (id !in protectedIds) byId.remove(id)?.let { dirty += it.bounds; any = true }
        if (any) changed()
    }

    /** Records one undoable edit: `before` are the old versions (absent for creations), `after` the new ones (absent for deletions). */
    fun edit(before: List<CanvasObject>, after: List<CanvasObject>) {
        if (before.isEmpty() && after.isEmpty()) return
        undoStack.addLast(Entry(before, after))
        if (undoStack.size > HISTORY_LIMIT) undoStack.removeFirst()
        redoStack.clear()
        apply(before, after)
    }

    fun undo() {
        val entry = undoStack.removeLastOrNull() ?: return
        redoStack.addLast(entry)
        apply(entry.after, entry.before)
    }

    fun redo() {
        val entry = redoStack.removeLastOrNull() ?: return
        undoStack.addLast(entry)
        apply(entry.before, entry.after)
    }

    /** Moves from one set of versions to another and syncs the difference. */
    private fun apply(from: List<CanvasObject>, to: List<CanvasObject>) {
        val now = nowIso()
        val toIds = to.map { it.id }.toSet()
        val deletes = from.filter { it.id !in toIds }.mapNotNull { byId.remove(it.id) }
        from.forEach { dirty += it.bounds }
        to.forEach { t -> byId[t.id]?.let { dirty += it.bounds }; dirty += t.bounds }
        val upserts = to.map { target ->
            // Keep the current revision so the server sees an edit of the latest version.
            val revision = byId[target.id]?.revision ?: target.revision
            target.copy(revision = revision, updatedAt = now).also { byId[it.id] = it }
        }
        changed()
        onCommit(upserts, deletes)
    }

    companion object {
        private const val HISTORY_LIMIT = 100
    }
}
