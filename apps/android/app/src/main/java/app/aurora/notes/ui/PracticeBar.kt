// Practice bar under the canvas, a compact port of the web's PracticeBar: status line,
// "Question N of M" segments, running score, and the Done / Next / Retry actions.
package app.aurora.notes.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.aurora.notes.data.PracticeSession
import kotlin.math.roundToInt

@Composable
fun PracticeBar(practice: PracticeState, modifier: Modifier = Modifier) {
    val session = practice.session ?: return
    val progress = session.options.progress
    val complete = session.status == "complete"
    val score = session.runningScore()

    Column(modifier.panel(Neo.shell, fill = Neo.surface).padding(horizontal = 14.dp, vertical = 4.dp)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Box(Modifier.weight(1f)) {
                if (progress.status) Label(session.statusText.orEmpty(), 13.sp, Neo.muted)
            }
            // Flexible, so the action buttons always keep their full width on a narrow canvas.
            if (progress.bar) ProgressSegments(session, Modifier.weight(1f, fill = false).widthIn(max = 280.dp))
            if (progress.runningScore && !complete && score != null) ScoreText(score)
            PracticeActions(practice, session, score)
        }
        practice.error?.let { message ->
            Label(message, 12.sp, Neo.danger, modifier = Modifier.heightIn(min = 32.dp).clickable { practice.error = null }.padding(vertical = 8.dp))
        }
    }
}

@Composable
private fun PracticeActions(practice: PracticeState, session: PracticeSession, score: Pair<Double, Double>?) {
    val question = session.openQuestion()
    val busy = practice.busy
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        when {
            session.status == "complete" -> {
                LucideIcon(Lucide.Check, 16, Neo.success)
                Label("Session complete", weight = FontWeight.SemiBold)
                if (score != null) ScoreText(score)
            }
            question?.state == "awaiting_work" -> PracticeButton(
                when (busy) { PracticeBusy.Syncing -> "Syncing…"; PracticeBusy.Sending -> "Sending…"; null -> "Done" },
                if (busy != null) Lucide.LoaderCircle else Lucide.Check,
                primary = true, enabled = busy == null, spinning = busy != null,
            ) { practice.submit(question) }
            question?.state == "graded" -> {
                // Retry is always offered on a graded question, whatever the session's feedback options say.
                PracticeButton("Retry", Lucide.RotateCcw, enabled = busy == null) { practice.retry(question) }
                PracticeButton("Next", Lucide.ArrowRight, primary = true, enabled = busy == null, iconAfter = true) { practice.next(question) }
            }
            else -> PracticeButton(
                if (question?.state == "submitted") "Grading…" else "Waiting…", Lucide.LoaderCircle, enabled = false, spinning = true,
            ) {}
        }
    }
}

@Composable
private fun PracticeButton(
    label: String,
    icon: ImageVector,
    primary: Boolean = false,
    enabled: Boolean = true,
    spinning: Boolean = false,
    iconAfter: Boolean = false,
    onClick: () -> Unit,
) {
    val ink = if (primary) Neo.accentContrast else Neo.text
    Row(
        Modifier.heightIn(min = 48.dp).widthIn(min = 104.dp)
            .panel(radius = Neo.radius, fill = if (primary) Neo.accent else Neo.surfaceRaised)
            .alpha(if (enabled) 1f else 0.6f)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
    ) {
        val iconModifier = if (spinning) Modifier.rotate(spinAngle()) else Modifier
        if (!iconAfter) LucideIcon(icon, 16, ink, iconModifier)
        Label(label, color = ink, weight = FontWeight.SemiBold)
        if (iconAfter) LucideIcon(icon, 16, ink, iconModifier)
    }
}

@Composable
private fun spinAngle(): Float {
    val angle by rememberInfiniteTransition(label = "spin").animateFloat(
        0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "spin",
    )
    return angle
}

@Composable
private fun ProgressSegments(session: PracticeSession, modifier: Modifier = Modifier) {
    val current = session.currentQuestionIndex()
    val position = current?.plus(1) ?: session.questions.size
    val byIndex = session.questions.associateBy { it.index }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Label("Question $position of ${session.totalQuestions}", 12.sp, Neo.muted)
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (index in 0 until session.totalQuestions) {
                val question = byIndex[index]
                val latest = question?.latestPoints
                val fill = when {
                    latest != null -> scoreColor(latest / question.maxPoints)
                    question != null -> Neo.muted.copy(alpha = 0.48f)
                    else -> Neo.muted.copy(alpha = 0.18f)
                }
                Spacer(
                    Modifier.weight(1f).height(8.dp)
                        .then(if (index == current) Modifier.border(2.dp, Neo.accent, CircleShape) else Modifier)
                        .clip(CircleShape).background(fill),
                )
            }
        }
    }
}

@Composable
private fun ScoreText(score: Pair<Double, Double>) {
    val (points, maxPoints) = score
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Label("${(points / maxPoints * 100).roundToInt()}%", 15.sp, weight = FontWeight.SemiBold)
        Label("${formatPoints(points)}/${formatPoints(maxPoints)} pts", 12.sp, Neo.muted)
    }
}

/** Red (0) → amber (0.5) → green (1), as on the web. */
private fun scoreColor(ratio: Double): Color {
    val r = ratio.coerceIn(0.0, 1.0).toFloat()
    val hue = if (r <= 0.5f) r * 2 * 38 else 38 + (r - 0.5f) * 2 * (130 - 38)
    return Color.hsl(hue, 0.72f, 0.56f)
}

private fun formatPoints(value: Double): String {
    val rounded = (value * 10).roundToInt() / 10.0
    return if (rounded % 1.0 == 0.0) rounded.toInt().toString() else rounded.toString()
}
