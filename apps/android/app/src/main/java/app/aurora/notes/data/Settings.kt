// Per-device preferences: server address, device id, sidebar and library tree state, scroll lock, and the remembered camera for each note.
package app.aurora.notes.data

import android.content.Context
import java.util.UUID

class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("aurora", Context.MODE_PRIVATE)

    var serverUrl: String
        get() = prefs.getString("serverUrl", DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(value) = prefs.edit().putString("serverUrl", value.trimEnd('/')).apply()

    val deviceId: String =
        prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("deviceId", it).apply()
        }

    var lastNoteId: String?
        get() = prefs.getString("lastNoteId", null)
        set(value) = prefs.edit().putString("lastNoteId", value).apply()

    fun camera(noteId: String): Camera? {
        val raw = prefs.getString("camera.$noteId", null) ?: return null
        val parts = raw.split(',').mapNotNull { it.toDoubleOrNull() }
        if (parts.size != 3 || parts[2] <= 0) return null
        return Camera(parts[0], parts[1], parts[2])
    }

    fun saveCamera(noteId: String, camera: Camera) {
        prefs.edit().putString("camera.$noteId", "${camera.x},${camera.y},${camera.zoom}").apply()
    }

    var sidebarWidth: Float
        get() = prefs.getFloat("sidebarWidth", 280f)
        set(value) = prefs.edit().putFloat("sidebarWidth", value).apply()

    var sidebarCollapsed: Boolean
        get() = prefs.getBoolean("sidebarCollapsed", false)
        set(value) = prefs.edit().putBoolean("sidebarCollapsed", value).apply()

    /** Projects and folders left open in the library tree. */
    var expandedTreeItems: Set<String>
        get() = prefs.getStringSet("expandedTreeItems", emptySet())!!.toSet()
        set(value) = prefs.edit().putStringSet("expandedTreeItems", value).apply()

    /** The horizontal scroll lock for vertically scrolling notes. */
    var lockX: Boolean
        get() = prefs.getBoolean("lockX", false)
        set(value) = prefs.edit().putBoolean("lockX", value).apply()

    fun pageCount(noteId: String): Int = prefs.getInt("pages.$noteId", 1)

    fun savePageCount(noteId: String, count: Int) = prefs.edit().putInt("pages.$noteId", count).apply()

    companion object {
        const val DEFAULT_SERVER = "https://power-server.tail14d560.ts.net:8443"
    }
}

/** Canvas position: world coordinate at the view's top-left and the zoom factor. */
data class Camera(val x: Double, val y: Double, val zoom: Double)
