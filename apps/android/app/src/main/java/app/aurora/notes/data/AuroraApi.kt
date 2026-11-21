// HTTP client for the Aurora server's /api routes.
package app.aurora.notes.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, message: String) : IOException(message)

class AuroraApi(private val settings: Settings) {
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonType = "application/json".toMediaType()

    private suspend fun call(method: String, path: String, body: JsonElement? = null): String =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(settings.serverUrl + path)
                .method(method, body?.toString()?.toRequestBody(jsonType))
                .build()
            http.newCall(request).execute().use { response ->
                val text = response.body.string()
                if (!response.isSuccessful) throw ApiException(response.code, "$method $path: ${response.code} $text")
                text
            }
        }

    suspend fun account(): Account = AuroraJson.decodeFromString(call("GET", "/api/account"))

    suspend fun library(): LibraryTree = AuroraJson.decodeFromString(call("GET", "/api/library"))

    suspend fun pageCount(noteId: String): Int =
        AuroraJson.decodeFromString<NoteDetail>(call("GET", "/api/notes/$noteId")).pages.size.coerceAtLeast(1)

    suspend fun addPageBelow(noteId: String, afterPageIndex: Int): Int =
        AuroraJson.decodeFromString<PageCreated>(
            call("POST", "/api/notes/$noteId/pages", buildJsonObject { put("afterPageIndex", afterPageIndex) }),
        ).pageCount

    suspend fun createProject(name: String) {
        call("POST", "/api/projects", buildJsonObject { put("name", name) })
    }

    suspend fun createFolder(projectId: String, name: String) {
        call("POST", "/api/projects/$projectId/folders", buildJsonObject { put("name", name) })
    }

    suspend fun createNote(projectId: String, folderId: String?, title: String, canvasMode: String, background: Background) {
        call("POST", "/api/notes", buildJsonObject {
            put("projectId", projectId)
            if (folderId != null) put("folderId", folderId)
            put("title", title)
            put("canvasMode", canvasMode)
            put("background", AuroraJson.encodeToJsonElement(Background.serializer(), background))
        })
    }

    suspend fun renameNote(noteId: String, title: String) {
        call("PATCH", "/api/notes/$noteId", buildJsonObject { put("title", title) })
    }

    suspend fun trashNote(noteId: String) {
        call("POST", "/api/notes/$noteId/trash", JsonObject(emptyMap()))
    }

    suspend fun restoreNote(noteId: String) {
        call("POST", "/api/notes/$noteId/restore", JsonObject(emptyMap()))
    }

    /** Purges a trashed note for good. */
    suspend fun deleteNoteForever(noteId: String) {
        call("DELETE", "/api/notes/$noteId")
    }

    /** Every object in the note; the server caps very large reads and reports truncation. */
    suspend fun queryObjects(noteId: String, region: Bounds): RegionalResponse =
        AuroraJson.decodeFromString(
            call("POST", "/api/notes/$noteId/objects/query", buildJsonObject {
                put("viewport", AuroraJson.encodeToJsonElement(Bounds.serializer(), region))
            }),
        )

    suspend fun sendOperations(operations: List<SyncOperation>): List<SyncAck> {
        val body = buildJsonObject {
            put("operations", AuroraJson.encodeToJsonElement(
                kotlinx.serialization.builtins.ListSerializer(SyncOperation.serializer()), operations,
            ))
        }
        return AuroraJson.decodeFromString<AckBatch>(call("POST", "/api/sync/operations", body)).acks
    }

    fun socketUrl(): String = settings.serverUrl.replaceFirst("http", "ws") + "/sync/ws"

    companion object {
        val EVERYTHING = Bounds(-1_000_000.0, -1_000_000.0, 2_000_000.0, 2_000_000.0)
    }
}
