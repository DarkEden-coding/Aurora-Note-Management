// Keeps this device and the server in step: queues local edits in a durable outbox,
// sends them in batches, applies acknowledgements, and merges live server broadcasts.
package app.aurora.notes.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.encodeToString
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
data class RemoteChange(
    val noteId: String,
    val objects: List<CanvasObject>,
    val deletedIds: List<String>,
    val localAcknowledgement: Boolean = false,
)

data class SyncStatus(val connected: Boolean = false, val pending: Int = 0, val lastError: String? = null)

class SyncEngine(
    private val api: AuroraApi,
    private val store: LocalStore,
    private val settings: Settings,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Mutex()
    private var outbox = mutableListOf<OutboxEntry>()
    private val localRevisions = mutableMapOf<String, IntRange>()
    private val loadOutbox = scope.async(start = CoroutineStart.LAZY) {
        lock.withLock {
            outbox = store.readOutbox().map { it.copy(nextAttemptAt = 0) }.toMutableList()
            publishPending()
        }
    }
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
    private val submitLock = Any()
    private var submission: Job? = null

    fun start() {
        if (running) return
        running = true
        flushJob = scope.launch {
            while (true) {
                flush()
                delay(FLUSH_INTERVAL_MS)
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
    suspend fun cachedObjects(noteId: String): List<CanvasObject> {
        loadOutbox.await()
        return lock.withLock { cacheFor(noteId).values.toList() }
    }

    /** Fetches the whole note from the server and merges it into the cache, keeping unsent local edits. */
    suspend fun refreshNote(noteId: String): List<CanvasObject> {
        loadOutbox.await()
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
        synchronized(submitLock) {
            val previous = submission
            val job = scope.launch(start = CoroutineStart.LAZY) {
                previous?.join()
                loadOutbox.await()
                lock.withLock {
                    val cache = cacheFor(noteId)
                    val now = Instant.now().toString()
                    val latest = outbox.withIndex().associate { it.value.op.objectId to it.index }.toMutableMap()
                    for (obj in upserts) {
                        val op = SyncOperation(UUID.randomUUID().toString(), settings.deviceId, noteId, obj.id,
                            obj.revision, now, Mutation("upsert", obj))
                        cache[obj.id] = enqueue(op, latest).mutation.`object`!!
                    }
                    for (obj in deletes) {
                        cache.remove(obj.id)
                        enqueue(SyncOperation(UUID.randomUUID().toString(), settings.deviceId, noteId, obj.id,
                            obj.revision, now, Mutation("delete")), latest)
                    }
                    store.writeOutbox(outbox)
                    store.writeNote(noteId, cache.values)
                    publishPending()
                }
            }
            submission = job
            job.invokeOnCompletion {
                synchronized(submitLock) { if (submission === job) submission = null }
            }
            job.start()
            scope.launch {
                job.join()
                delay(FLUSH_DEBOUNCE_MS)
                flush()
            }
        }
    }

    /**
     * Sends the note's queued edits now and waits until the server has acknowledged all of them,
     * e.g. before a practice submission, which the server renders from synced strokes.
     */
    suspend fun awaitNoteSynced(noteId: String, timeoutMs: Long = NOTE_SYNC_TIMEOUT_MS) {
        synchronized(submitLock) { submission }?.join()
        loadOutbox.await()
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

    /** Only coalesce an edit that has never been sent. */
    private fun enqueue(op: SyncOperation, latest: MutableMap<String, Int>): SyncOperation {
        val index = latest[op.objectId]
        val previous = index?.let { outbox[it] }
        if (index != null && previous != null && !previous.sent && previous.attempts == 0) {
            val merged = op.copy(id = previous.op.id, baseRevision = previous.op.baseRevision)
            outbox[index] = previous.copy(op = merged)
            return merged
        }
        val revisions = localRevisions[op.objectId]
        val next = if (previous == null && revisions != null && op.baseRevision in revisions) {
            rebase(op, revisions.last)
        } else op
        latest[op.objectId] = outbox.size
        val now = System.currentTimeMillis()
        outbox.add(OutboxEntry(next, if (previous == null) now else maxOf(now, previous.createdAt + 1)))
        return next
    }

    private fun rebase(op: SyncOperation, revision: Int, createdAt: String? = null): SyncOperation =
        op.copy(baseRevision = revision, mutation = op.mutation.copy(
            `object` = op.mutation.`object`?.let { it.copy(revision = revision, createdAt = createdAt ?: it.createdAt) },
        ))

    private fun pendingObjectIds(noteId: String): Set<String> =
        outbox.filter { it.op.noteId == noteId }.map { it.op.objectId }.toSet()

    private val flushLock = Mutex()

    private suspend fun flush() {
        loadOutbox.await()
        flushLock.withLock {
            while (true) {
                val batch = lock.withLock {
                    val now = System.currentTimeMillis()
                    val seen = mutableSetOf<String>()
                    val due = outbox.indices.sortedBy { outbox[it].createdAt }.asSequence()
                        .filter { seen.add(outbox[it].op.objectId) && outbox[it].nextAttemptAt <= now }
                        .take(BATCH_SIZE)
                    val batch = mutableListOf<OutboxEntry>()
                    var bytes = "{\"orderedEdits\":true,\"operations\":[]}".length
                    for (index in due) {
                        val row = outbox[index]
                        bytes += AuroraJson.encodeToString(row.op).encodeToByteArray().size
                        if (batch.isNotEmpty()) {
                            bytes++
                            if (bytes > SYNC_REQUEST_BODY_LIMIT) break
                        }
                        val sent = row.copy(sent = true)
                        outbox[index] = sent
                        batch += sent
                    }
                    if (batch.isNotEmpty()) store.writeOutbox(outbox)
                    batch
                }
                if (batch.isEmpty()) return
                val acks = try {
                    api.sendOperations(batch.map { it.op }).associateBy { it.operationId }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    lock.withLock {
                        val ids = batch.map { it.op.id }.toSet()
                        outbox = outbox.map { if (it.op.id in ids) retry(it) else it }.toMutableList()
                        store.writeOutbox(outbox)
                    }
                    _status.value = _status.value.copy(lastError = error.message)
                    return
                }

                val conflictedNotes = mutableSetOf<String>()
                val changes = lock.withLock {
                    val updatedObjects = mutableMapOf<String, MutableList<CanvasObject>>()
                    val batchIds = batch.map { it.op.id }.toSet()
                    val successors = outbox.indices.filter { outbox[it].op.id !in batchIds }
                        .groupBy { outbox[it].op.objectId }
                    val completed = mutableSetOf<String>()
                    val missing = mutableSetOf<String>()
                    for (entry in batch) {
                        val op = entry.op
                        val ack = acks[op.id]
                        if (ack == null) {
                            missing += op.id
                            continue
                        }
                        completed += op.id
                        if (ack.status == "conflict") {
                            localRevisions.remove(op.objectId)
                            conflictedNotes += op.noteId
                            continue
                        }
                        val authoritative = ack.`object`
                        val revision = when {
                            op.mutation.type == "delete" -> 0
                            ack.resultRevision != null -> ack.resultRevision
                            ack.status == "duplicate" && (authoritative?.revision ?: 0) > op.baseRevision + 1 -> null
                            else -> authoritative?.revision
                        }
                        if (op.mutation.type == "upsert" && revision != null) {
                            val previous = localRevisions[op.objectId]
                            val from = if (previous?.last == op.baseRevision) previous.first else op.baseRevision
                            localRevisions[op.objectId] = from..revision
                        } else {
                            localRevisions.remove(op.objectId)
                        }
                        val later = successors[op.objectId].orEmpty()
                        val next = later.firstOrNull()
                        if (next != null && revision != null && !outbox[next].sent && outbox[next].attempts == 0) {
                            val row = outbox[next]
                            outbox[next] = row.copy(op = rebase(row.op, revision, if (op.mutation.type == "upsert") authoritative?.createdAt else null))
                        }
                        val draft = later.lastOrNull()?.let { outbox[it].op }
                        val objectToCache = if (draft == null) authoritative else draft.mutation.`object`
                        val cache = cacheFor(op.noteId)
                        if (objectToCache == null) {
                            cache.remove(op.objectId)
                        } else {
                            cache[op.objectId] = objectToCache
                            updatedObjects.getOrPut(op.noteId) { mutableListOf() }.add(objectToCache)
                        }
                    }
                    outbox = outbox.filter { it.op.id !in completed }
                        .map { if (it.op.id in missing) retry(it) else it }.toMutableList()
                    batch.map { it.op.noteId }.distinct().forEach { store.writeNote(it, cacheFor(it).values) }
                    store.writeOutbox(outbox)
                    _status.value = _status.value.copy(lastError = if (missing.isEmpty()) null else "Missing acknowledgement")
                    publishPending()
                    updatedObjects.map { (noteId, objects) -> RemoteChange(noteId, objects, emptyList(), localAcknowledgement = true) }
                }
                for (change in changes) _remote.emit(change)
                for (noteId in conflictedNotes) {
                    val objects = runCatching { refreshNote(noteId) }.getOrNull() ?: continue
                    _remote.emit(RemoteChange(noteId, objects, emptyList()))
                }
            }
        }
    }

    private fun retry(entry: OutboxEntry): OutboxEntry =
        entry.copy(attempts = entry.attempts + 1, nextAttemptAt = System.currentTimeMillis() + backoff(entry.attempts + 1))

    private fun publishPending() {
        _status.value = _status.value.copy(pending = outbox.size)
    }

    // ---- Live updates ----------------------------------------------------

    private fun connectSocket() {
        socketJob = scope.launch {
            var attempt = 0
            while (running) {
                val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
                val messages = Channel<String>(Channel.UNLIMITED)
                val receive = launch {
                    for (text in messages) handleEvent(text)
                }
                val request = Request.Builder().url(api.socketUrl()).build()
                socket = api.http.newWebSocket(request, object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        attempt = 0
                        _status.value = _status.value.copy(connected = true)
                        scope.launch { flush() }
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        messages.trySend(text)
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.complete(Unit) }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { closed.complete(Unit) }
                })
                closed.await()
                messages.close()
                receive.join()
                _status.value = _status.value.copy(connected = false)
                attempt += 1
                delay(min(30_000L, 1_000L shl min(attempt, 5)))
            }
        }
    }

    private suspend fun handleEvent(text: String) {
        loadOutbox.await()
        val event = runCatching { AuroraJson.parseToJsonElement(text) as JsonObject }.getOrNull() ?: return
        when (event["type"]?.jsonPrimitive?.content) {
            "objects-changed" -> {
                val noteId = event["noteId"]?.jsonPrimitive?.content ?: return
                val objects = AuroraJson.decodeFromJsonElement(ListSerializer(CanvasObject.serializer()), event["objects"]!!)
                val deleted = event["deletedObjectIds"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()
                val change = lock.withLock {
                    val pending = pendingObjectIds(noteId)
                    val cache = cacheFor(noteId)
                    val accepted = objects.filter { it.id !in pending && (cache[it.id]?.revision ?: -1) <= it.revision }
                    val removed = deleted.filter { it !in pending }
                    accepted.forEach { cache[it.id] = it }
                    removed.forEach { cache.remove(it) }
                    if (accepted.isNotEmpty() || removed.isNotEmpty()) store.writeNote(noteId, cache.values)
                    RemoteChange(noteId, accepted, removed)
                }
                if (change.objects.isNotEmpty() || change.deletedIds.isNotEmpty()) _remote.emit(change)
            }
            "library-changed", "note-changed" -> _libraryChanged.emit(Unit)
            "practice-changed" -> event["noteId"]?.jsonPrimitive?.content?.let { _practiceChanged.emit(it) }
        }
    }

    private suspend fun cacheFor(noteId: String): MutableMap<String, CanvasObject> =
        noteCache.getOrPut(noteId) {
            val cache = store.readNote(noteId).associateBy { it.id }.toMutableMap()
            for (entry in outbox) {
                if (entry.op.noteId != noteId) continue
                val objectToCache = entry.op.mutation.`object`
                if (objectToCache == null) cache.remove(entry.op.objectId)
                else cache[entry.op.objectId] = objectToCache
            }
            cache
        }

    private fun backoff(attempt: Int): Long = min(5 * 60_000L, 1_000L shl min(attempt - 1, 18))

    companion object {
        private const val FLUSH_INTERVAL_MS = 3_000L
        private const val FLUSH_DEBOUNCE_MS = 100L
        private const val BATCH_SIZE = 50
        private const val SYNC_REQUEST_BODY_LIMIT = 8 * 1024 * 1024
        private const val NOTE_SYNC_TIMEOUT_MS = 20_000L
        private const val NOTE_SYNC_POLL_MS = 400L
    }
}
