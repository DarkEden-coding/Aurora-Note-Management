// The open note's guided-practice session and the Done / Next / Retry actions the practice bar sends.
package app.aurora.notes.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.aurora.notes.data.ApiException
import app.aurora.notes.data.AuroraApi
import app.aurora.notes.data.PracticeQuestion
import app.aurora.notes.data.PracticeSession
import app.aurora.notes.data.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

enum class PracticeBusy { Syncing, Sending }

class PracticeState(private val api: AuroraApi, private val sync: SyncEngine, private val scope: CoroutineScope) {
    /** Null when the open note has no practice session. */
    var session by mutableStateOf<PracticeSession?>(null)
        private set
    var busy by mutableStateOf<PracticeBusy?>(null)
        private set
    var error by mutableStateOf<String?>(null)

    private var noteId: String? = null
    private var loadJob: Job? = null

    /** Shows the session of [noteId] (null: no note open); call again to reload the same note. */
    fun load(noteId: String?) {
        if (noteId != this.noteId) {
            this.noteId = noteId
            session = null
            busy = null
            error = null
        }
        loadJob?.cancel()
        if (noteId == null) return
        loadJob = scope.launch {
            // A failed reload keeps what is shown; the next broadcast or note open tries again.
            runCatching { api.practiceSession(noteId) }.onSuccess { if (this@PracticeState.noteId == noteId) session = it }
        }
    }

    /** Done: the server grades a render of the page, so the note's strokes must reach it first. */
    fun submit(question: PracticeQuestion) = run(syncFirst = true) { api.submitPracticeQuestion(question.id) }

    fun next(question: PracticeQuestion) = run(syncFirst = false) { api.practiceAction(question.id, "next") }

    fun retry(question: PracticeQuestion) = run(syncFirst = false) { api.practiceAction(question.id, "retry") }

    private fun run(syncFirst: Boolean, task: suspend () -> PracticeSession) {
        val noteId = noteId ?: return
        if (busy != null) return
        error = null
        scope.launch {
            val stillOpen = { this@PracticeState.noteId == noteId }
            try {
                if (syncFirst) {
                    busy = PracticeBusy.Syncing
                    try {
                        sync.awaitNoteSynced(noteId)
                    } catch (e: Exception) {
                        if (stillOpen()) error = e.message ?: "Sync failed."
                        return@launch
                    }
                }
                if (!stillOpen()) return@launch
                busy = PracticeBusy.Sending
                try {
                    val updated = task()
                    if (stillOpen()) session = updated
                } catch (e: Exception) {
                    if (!stillOpen()) return@launch
                    // 409: the question moved on elsewhere (another device or the grader); just catch up.
                    if (!(e is ApiException && e.status == 409)) error = "Couldn't send that. Try again."
                    load(noteId)
                }
            } finally {
                if (stillOpen()) busy = null
            }
        }
    }
}

/** The question the user is working on: the latest one that is not closed. */
fun PracticeSession.openQuestion(): PracticeQuestion? =
    questions.filter { it.state != "closed" }.maxByOrNull { it.index }

/** Zero-based index of the current question; the next one while it is being written. */
fun PracticeSession.currentQuestionIndex(): Int? {
    if (status == "complete") return null
    openQuestion()?.let { return it.index }
    return if (questions.size < totalQuestions) questions.size else null
}

/** First-attempt points over max points of graded questions, or null before any grade. */
fun PracticeSession.runningScore(): Pair<Double, Double>? {
    val graded = questions.filter { it.points != null }
    if (graded.isEmpty()) return null
    return graded.sumOf { it.points!! } to graded.sumOf { it.maxPoints }
}
