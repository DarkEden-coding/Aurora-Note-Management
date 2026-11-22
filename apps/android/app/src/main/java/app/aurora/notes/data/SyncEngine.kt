// Keeps this device and the server in step: queues local edits in a durable outbox,
// sends them in batches, applies acknowledgements, and merges live server broadcasts.
package app.aurora.notes.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.time.Instant
import java.util.UUID
import kotlin.math.min

/** A server-side change to objects in one note. */
data class RemoteChange(val noteId: String, val objects: List<CanvasObject>, val deletedIds: List<String>)

data class SyncStatus(val connected: Boolean = false, val pending: Int = 0, val lastError: String? = null)

class SyncEngine(
    private val api: AuroraApi,
    private val store: LocalStore,
    private val settings: Settings,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Mutex()
    private var outbox = mutableListOf<OutboxEntry>()
    private val inFlight = mutableMapOf<String, SyncOperation>()
    private val noteCache = mutableMapOf<String, MutableMap<String, CanvasObject>>()
    private var socket: WebSocket? = null
    private var socketJob: Job? = null
    private var flushJob: Job? = null
    private var running = false

    private val _status = MutableStateFlow(SyncStatus())
    val status: StateFlow<SyncStatus> = _status

    private val _remote = MutableSharedFlow<RemoteChange>(extraBufferCapacity = 64)
    val remoteChanges: SharedFlow<RemoteChange> = _remote

    private val _libraryChanged = MutableSharedFlow<Unit>(extraBufferCapacity = 8)
    val libraryChanged: SharedFlow<Unit> = _libraryChanged

    /** Note ids whose guided-practice session changed on the server. */
    private val _practiceChanged = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val practiceChanged: SharedFlow<String> = _practiceChanged

    /** Edits handed to [submit] that may not have reached the outbox yet. */
    private val submitting = java.util.Collections.synchronizedSet(mutableSetOf<Job>())

    fun start() {
        if (running) return
        running = true
        scope.launch {
            // A fresh start retries everything right away instead of waiting out an old backoff.
            lock.withLock { outbox = store.readOutbox().map { it.copy(nextAttemptAt = 0) }.toMutableList() }
            publishPending()
            flushJob = scope.launch {
                while (true) {
                    flush()
                    delay(FLUSH_INTERVAL_MS)
                }
            }
        }
        connectSocket()
    }

    /** Called when the app goes to the background: send what is queued, then disconnect. */
    fun stop() {
        if (!running) return
        running = false
        scope.launch { flush() }
        flushJob?.cancel()
        socketJob?.cancel()
        socket?.close(1000, null)
        socket = null
        _status.value = _status.value.copy(connected = false)
    }

    // ---- Notes -----------------------------------------------------------

    /** Cached objects for a note, available offline. */
    suspend fun cachedObjects(noteId: String): List<CanvasObject> = lock.withLock { cacheFor(noteId).values.toList() }

    /** Fetches the whole note from the server and merges it into the cache, keeping unsent local edits. */
    suspend fun refreshNote(noteId: String): List<CanvasObject> {
        val response = api.queryObjects(noteId, AuroraApi.EVERYTHING)
        return lock.withLock {
            val cache = cacheFor(noteId)
            val pending = pendingObjectIds(noteId)
            val returned = response.objects.associateBy { it.id }
            for ((id, obj) in returned) {
                if (id in pending) continue
                val current = cache[id]
                if (current == null || obj.revision >= current.revision) cache[id] = obj
            }
            if (!response.truncated) {
                cache.keys.filter { it !in returned && it !in pending }.forEach { cache.remove(it) }
            }
            store.writeNote(noteId, cache.values)
            cache.values.toList()
        }
    }

    /** Records local upserts and deletes for a note and queues them for the server. */
    fun submit(noteId: String, upserts: List<CanvasObject>, deletes: List<CanvasObject>) {
        if (upserts.isEmpty() && deletes.isEmpty()) return
        val job = scope.launch(start = kotlinx.coroutines.CoroutineStart.LAZY) {
            lock.withLock {
                val cache = cacheFor(noteId)
                val now = Instant.now().toString()
                for (obj in upserts) {
                    cache[obj.id] = obj
                    enqueue(SyncOperation(UUID.randomUUID().toString(), settings.deviceId, noteId, obj.id,
                        obj.revision, now, Mutation("upsert", obj)))
                }
                for (obj in deletes) {
                    cache.remove(obj.id)
                    enqueue(SyncOperation(UUID.randomUUID().toString(), settings.deviceId, noteId, obj.id,
                        obj.revision, now, Mutation("delete")))
                }
                store.writeNote(noteId, cache.values)
                store.writeOutbox(outbox)
            }
            publishPending()
            delay(FLUSH_DEBOUNCE_MS)
            flush()
        }
        submitting += job
        job.invokeOnCompletion { submitting -= job }
        job.start()
    }

    /**
     * Sends the note's queued edits now and waits until the server has acknowledged all of them,
     * e.g. before a practice submission, which the server renders from synced strokes.
     */
    suspend fun awaitNoteSynced(noteId: String, timeoutMs: Long = NOTE_SYNC_TIMEOUT_MS) {
        synchronized(submitting) { submitting.toList() }.forEach { it.join() }
        val synced = kotlinx.coroutines.withTimeoutOrNull(timeoutMs) {
            while (true) {
                val pending = lock.withLock {
                    // Skip any retry backoff for this note's edits: the user is waiting on them.
                    outbox = outbox.map { if (it.op.noteId == noteId) it.copy(nextAttemptAt = 0) else it }.toMutableList()
                    outbox.any { it.op.noteId == noteId }
                }
                if (!pending) break
                flush()
                delay(NOTE_SYNC_POLL_MS)
            }
            true
        }
        if (synced == null) throw java.io.IOException("Your latest strokes haven't synced yet. Check the connection and try again.")
    }

    // ---- Outbox ----------------------------------------------------------

    /** Folds a new edit into a queued, unsent edit of the same object so only the latest state travels. */
    private fun enqueue(op: SyncOperation) {
        val index = outbox.indexOfFirst { it.op.objectId == op.objectId && it.op.id !in inFlight.values.map { f -> f.id } }
        if (index >= 0) {
            val queued = outbox[index]
            outbox[index] = queued.copy(op = op.copy(id = queued.op.id, baseRevision = queued.op.baseRevision), attempts = 0, nextAttemptAt = 0)
            return
        }
        val flying = inFlight[op.objectId]
        val next = if (flying != null) op.copy(baseRevision = flying.baseRevision + 1) else op
        outbox.add(OutboxEntry(next, System.currentTimeMillis()))
    }

    private fun pendingObjectIds(noteId: String): Set<String> =
        outbox.filter { it.op.noteId == noteId }.map { it.op.objectId }.toSet()

    private val flushLock = Mutex()

    private suspend fun flush() {
        if (!flushLock.tryLock()) return
        try {
            val batch = lock.withLock {
                val now = System.currentTimeMillis()
                outbox.filter { it.nextAttemptAt <= now }.sortedBy { it.createdAt }.take(BATCH_SIZE)
                    .onEach { inFlight[it.op.objectId] = it.op }
            }
            if (batch.isEmpty()) return
            val acks = try {
                api.sendOperations(batch.map { it.op })
            } catch (error: Exception) {
                lock.withLock {
                    batch.forEach { inFlight.remove(it.op.objectId) }
                    val now = System.currentTimeMillis()
                    val ids = batch.map { it.op.id }.toSet()
                    outbox = outbox.map {
                        if (it.op.id in ids) it.copy(attempts = it.attempts + 1, nextAttemptAt = now + backoff(it.attempts + 1)) else it
                    }.toMutableList()
                    store.writeOutbox(outbox)
                }
                _status.value = _status.value.copy(lastError = error.message)
                return
            }
            val conflictedNotes = mutableSetOf<String>()
            lock.withLock {
                for (entry in batch) inFlight.remove(entry.op.objectId)
                for (ack in acks) {
                    val entry = batch.firstOrNull { it.op.id == ack.operationId } ?: continue
                    outbox.removeAll { it.op.id == ack.operationId }
                    if (ack.status == "conflict") {
                        // The server keeps both versions for the web conflict dialog; show the server's here.
                        conflictedNotes += entry.op.noteId
                        continue
                    }
                    val authoritative = ack.`object` ?: continue
                    val cache = cacheFor(entry.op.noteId)
                    val laterIndex = outbox.indexOfFirst { it.op.objectId == authoritative.id && it.op.mutation.type == "upsert" }
                    if (laterIndex >= 0) {
                        // A newer local edit is still queued: keep its content, adopt the server revision.
                        val later = outbox[laterIndex]
                        val draft = later.op.mutation.`object`!!.copy(revision = authoritative.revision, createdAt = authoritative.createdAt)
                        outbox[laterIndex] = later.copy(op = later.op.copy(
                            baseRevision = maxOf(later.op.baseRevision, authoritative.revision),
                            mutation = Mutation("upsert", draft),
                        ))
                        cache[draft.id] = draft
                    } else if (cache.containsKey(authoritative.id)) {
                        cache[authoritative.id] = authoritative
                    }
                    _remote.tryEmit(RemoteChange(entry.op.noteId, listOf(cache[authoritative.id] ?: authoritative), emptyList()))
                }
                store.writeOutbox(outbox)
                batch.map { it.op.noteId }.distinct().forEach { store.writeNote(it, cacheFor(it).values) }
            }
            _status.value = _status.value.copy(lastError = null)
            publishPending()
            for (noteId in conflictedNotes) {
                val objects = runCatching { refreshNote(noteId) }.getOrNull() ?: continue
                _remote.tryEmit(RemoteChange(noteId, objects, emptyList()))
            }
        } finally {
            flushLock.unlock()
        }
    }

    private fun publishPending() {
        _status.value = _status.value.copy(pending = outbox.size)
    }

    // ---- Live updates ----------------------------------------------------

    private fun connectSocket() {
        socketJob = scope.launch {
            var attempt = 0
            while (running) {
                val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
                val request = Request.Builder().url(api.socketUrl()).build()
                socket = api.http.newWebSocket(request, object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        attempt = 0
                        _status.value = _status.value.copy(connected = true)
                        scope.launch { flush() }
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        scope.launch { handleEvent(text) }
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.complete(Unit) }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { closed.complete(Unit) }
                })
                closed.await()
                _status.value = _status.value.copy(connected = false)
                attempt += 1
                delay(min(30_000L, 1_000L shl min(attempt, 5)))
            }
        }
    }

    private suspend fun handleEvent(text: String) {
        val event = runCatching { AuroraJson.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return
        when (event["type"]?.jsonPrimitive?.content) {
            "objects-changed" -> {
                val noteId = event["noteId"]?.jsonPrimitive?.content ?: return
                val objects = AuroraJson.decodeFromJsonElement(ListSerializer(CanvasObject.serializer()), event["objects"]!!)
                val deleted = event["deletedObjectIds"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
                val change = lock.withLock {
                    val pending = pendingObjectIds(noteId) + inFlight.keys
                    val cache = cacheFor(noteId)
                    val accepted = objects.filter { it.id !in pending && (cache[it.id]?.revision ?: -1) <= it.revision }
                    val removed = deleted.filter { it !in pending }
                    accepted.forEach { cache[it.id] = it }
                    removed.forEach { cache.remove(it) }
                    store.writeNote(noteId, cache.values)
                    RemoteChange(noteId, accepted, removed)
                }
                if (change.objects.isNotEmpty() || change.deletedIds.isNotEmpty()) _remote.emit(change)
            }
            "library-changed", "note-changed" -> _libraryChanged.emit(Unit)
            "practice-changed" -> event["noteId"]?.jsonPrimitive?.content?.let { _practiceChanged.emit(it) }
        }
    }

    private suspend fun cacheFor(noteId: String): MutableMap<String, CanvasObject> =
        noteCache.getOrPut(noteId) { store.readNote(noteId).associateBy { it.id }.toMutableMap() }

    private fun backoff(attempt: Int): Long = min(5 * 60_000L, 1_000L shl min(attempt - 1, 18))

    companion object {
        private const val FLUSH_INTERVAL_MS = 3_000L
        private const val FLUSH_DEBOUNCE_MS = 100L
        private const val BATCH_SIZE = 50
        private const val NOTE_SYNC_TIMEOUT_MS = 20_000L
        private const val NOTE_SYNC_POLL_MS = 400L
    }
}
