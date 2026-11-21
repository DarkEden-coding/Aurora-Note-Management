// Kotlin mirror of packages/shared/src/contracts.ts: the transport shapes this client exchanges with the server.
package app.aurora.notes.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

val AuroraJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = true
    encodeDefaults = true
}

@Serializable
data class Bounds(val x: Double, val y: Double, val width: Double, val height: Double) {
    val right get() = x + width
    val bottom get() = y + height
    fun intersects(o: Bounds) = x <= o.right && right >= o.x && y <= o.bottom && bottom >= o.y
    fun contains(px: Double, py: Double) = px >= x && px <= right && py >= y && py <= bottom
    fun translate(dx: Double, dy: Double) = copy(x = x + dx, y = y + dy)
}

@Serializable
data class Background(
    val pattern: String = "dot-grid",
    val color: String = "#1b1d21",
    val patternColor: String = "#3a3f4a",
    val spacing: Double = 24.0,
)

@Serializable
data class CanvasObject(
    val id: String,
    val ownerId: String,
    val noteId: String,
    val pageId: String? = null,
    val kind: String,
    val bounds: Bounds,
    val rotation: Double = 0.0,
    val zIndex: Int = 0,
    val locked: Boolean = false,
    val groupId: String? = null,
    val payload: JsonObject = JsonObject(emptyMap()),
    val revision: Int = 0,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class Mutation(val type: String, val `object`: CanvasObject? = null)

@Serializable
data class SyncOperation(
    val id: String,
    val deviceId: String,
    val noteId: String,
    val objectId: String,
    val baseRevision: Int,
    val clientTimestamp: String,
    val mutation: Mutation,
)

@Serializable
data class SyncAck(
    val operationId: String,
    val status: String,
    val `object`: CanvasObject? = null,
    val conflictId: String? = null,
)

@Serializable
data class AckBatch(val acks: List<SyncAck>)

@Serializable
data class LibraryProject(val id: String, val name: String, val order: Int = 0)

@Serializable
data class LibraryFolder(val id: String, val projectId: String, val parentId: String? = null, val name: String)

@Serializable
data class LibraryNote(
    val id: String,
    val projectId: String,
    val folderId: String? = null,
    val title: String,
    val kind: String = "canvas",
    val canvasMode: String = "infinite",
    val background: Background = Background(),
    val favorite: Boolean = false,
    val trashed: Boolean = false,
    val archived: Boolean = false,
    val revision: Int = 0,
    val updatedAt: String = "",
)

@Serializable
data class LibraryTree(
    val projects: List<LibraryProject> = emptyList(),
    val folders: List<LibraryFolder> = emptyList(),
    val notes: List<LibraryNote> = emptyList(),
)

@Serializable
data class Account(val ownerId: String, val drawingPalette: List<String> = listOf("#000000"))

@Serializable
data class RegionalResponse(val objects: List<CanvasObject>, val truncated: Boolean = false)

@Serializable
data class PageJson(val id: String, val noteId: String, val pageIndex: Int)

@Serializable
data class NoteDetail(val pages: List<PageJson> = emptyList())

@Serializable
data class ProjectEnvelope(val project: ProjectJson)

@Serializable
data class ProjectJson(val id: String, val name: String, @SerialName("sortOrder") val sortOrder: Int = 0)

@Serializable
data class PageCreated(val pageCount: Int)

@Serializable
data class FileEnvelope(val file: FileJson)

@Serializable
data class FileJson(val id: String)
