// On-device cache: each note's objects and the operation outbox, stored as JSON files so the app works offline.
package app.aurora.notes.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.io.File

@Serializable
data class OutboxEntry(
    val op: SyncOperation,
    val createdAt: Long,
    val attempts: Int = 0,
    val nextAttemptAt: Long = 0,
)

class LocalStore(context: Context) {
    private val notesDir = File(context.filesDir, "notes").apply { mkdirs() }
    private val outboxFile = File(context.filesDir, "outbox.json")
    private val libraryFile = File(context.filesDir, "library.json")
    private val mutex = Mutex()

    suspend fun readNote(noteId: String): List<CanvasObject> = read(File(notesDir, "$noteId.json")) {
        AuroraJson.decodeFromString(ListSerializer(CanvasObject.serializer()), it)
    } ?: emptyList()

    suspend fun writeNote(noteId: String, objects: Collection<CanvasObject>) =
        write(File(notesDir, "$noteId.json"), AuroraJson.encodeToString(ListSerializer(CanvasObject.serializer()), objects.toList()))

    suspend fun readOutbox(): List<OutboxEntry> = read(outboxFile) {
        AuroraJson.decodeFromString(ListSerializer(OutboxEntry.serializer()), it)
    } ?: emptyList()

    suspend fun writeOutbox(entries: List<OutboxEntry>) =
        write(outboxFile, AuroraJson.encodeToString(ListSerializer(OutboxEntry.serializer()), entries))

    suspend fun readLibrary(): LibraryTree? = read(libraryFile) { AuroraJson.decodeFromString(LibraryTree.serializer(), it) }

    suspend fun writeLibrary(tree: LibraryTree) = write(libraryFile, AuroraJson.encodeToString(LibraryTree.serializer(), tree))

    private suspend fun <T> read(file: File, decode: (String) -> T): T? = withContext(Dispatchers.IO) {
        mutex.withLock {
            if (!file.exists()) null else runCatching { decode(file.readText()) }.getOrNull()
        }
    }

    /** Writes through a temp file so a crash never leaves half a file behind. */
    private suspend fun write(file: File, text: String) = withContext(Dispatchers.IO) {
        mutex.withLock {
            val temp = File(file.parentFile, file.name + ".tmp")
            temp.writeText(text)
            temp.renameTo(file)
        }
    }
}
