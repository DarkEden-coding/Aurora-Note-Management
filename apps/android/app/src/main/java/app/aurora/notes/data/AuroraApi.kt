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

    /** Raw bytes of an uploaded file (images on the canvas). */
    suspend fun fileBytes(fileId: String): ByteArray = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(settings.serverUrl + "/api/files/" + java.net.URLEncoder.encode(fileId, "UTF-8")).build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw ApiException(response.code, "GET file $fileId: ${response.code}")
            response.body.bytes()
        }
    }

    /** Uploads a file (a scanned page) and returns its id for an image object's payload. */
    suspend fun uploadFile(name: String, bytes: ByteArray, mimeType: String): String = withContext(Dispatchers.IO) {
        val body = okhttp3.MultipartBody.Builder().setType(okhttp3.MultipartBody.FORM)
            .addFormDataPart("file", name, bytes.toRequestBody(mimeType.toMediaType()))
            .build()
        val request = Request.Builder().url(settings.serverUrl + "/api/files").post(body).build()
        http.newCall(request).execute().use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) throw ApiException(response.code, "Upload failed (${response.code})")
            AuroraJson.decodeFromString<FileEnvelope>(text).file.id
        }
    }

    suspend fun account(): Account = AuroraJson.decodeFromString(call("GET", "/api/account"))

    suspend fun setDrawingPalette(palette: List<String>) {
        call("PATCH", "/api/account/drawing-palette", buildJsonObject {
            put("drawingPalette", kotlinx.serialization.json.JsonArray(palette.map { kotlinx.serialization.json.JsonPrimitive(it) }))
        })
    }

    suspend fun renameProject(projectId: String, name: String) {
        call("PATCH", "/api/projects/$projectId", buildJsonObject { put("name", name) })
    }

    suspend fun deleteProject(projectId: String) {
        call("DELETE", "/api/projects/$projectId")
    }

    suspend fun renameFolder(folderId: String, name: String) {
        call("PATCH", "/api/folders/$folderId", buildJsonObject { put("name", name) })
    }

    suspend fun deleteFolder(folderId: String) {
        call("DELETE", "/api/folders/$folderId")
    }

    suspend fun setFavorite(noteId: String, favorite: Boolean) {
        call("POST", "/api/notes/$noteId/${if (favorite) "favorite" else "unfavorite"}", JsonObject(emptyMap()))
    }

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

    suspend fun createFolder(projectId: String, name: String, parentId: String? = null) {
        call("POST", "/api/projects/$projectId/folders", buildJsonObject {
            put("name", name)
            if (parentId != null) put("parentId", parentId)
        })
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

    /** The note's guided-practice session, or null when the note has none. */
    suspend fun practiceSession(noteId: String): PracticeSession? = try {
        AuroraJson.decodeFromString(call("GET", "/api/practice/notes/$noteId"))
    } catch (e: ApiException) {
        if (e.status == 404) null else throw e
    }

    /** Hands the open question to the grader; the server renders the page from synced strokes. */
    suspend fun submitPracticeQuestion(questionId: String): PracticeSession =
        AuroraJson.decodeFromString(call("POST", "/api/practice/questions/$questionId/submit", JsonObject(emptyMap())))

    /** "next" or "retry" on a graded question. */
    suspend fun practiceAction(questionId: String, action: String): PracticeSession =
        AuroraJson.decodeFromString(call("POST", "/api/practice/questions/$questionId/action", buildJsonObject { put("action", action) }))

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
