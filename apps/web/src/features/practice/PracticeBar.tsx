// Practice bar below the canvas: status line, segmented question progress, running score, topic mastery, and the Done / Next / Retry actions. Done waits for the note's strokes to sync before submitting.
import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import type { PracticeSession } from "@aurora/shared";
import { ApiError } from "../../lib/http.js";
import { syncEngine } from "../../sync/engine.js";
import { sendPracticeAction, submitPracticeQuestion } from "./api.js";
import { measureCardRegions } from "./cardLayout.js";
import {
  currentQuestionIndex,
  formatPoints,
  openQuestion,
  progressSegments,
  runningScore,
  scoreColor,
  topicMastery,
  type Score,
} from "./progress.js";
import "./practice.css";

type Busy = "syncing" | "sending" | null;

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function ScoreText({ score }: { score: Score }): ReactNode {
  return (
    <span className="practice-score">
      <strong>{percent(score.ratio)}</strong>
      <span>
        {formatPoints(score.points)}/{formatPoints(score.maxPoints)} pts
      </span>
    </span>
  );
}

function ProgressBar({ session }: { session: PracticeSession }): ReactNode {
  const segments = progressSegments(session);
  const current = currentQuestionIndex(session);
  const position = current !== null ? current + 1 : session.questions.length;
  return (
    <div
      className="practice-progress"
      role="img"
      aria-label={`Question ${position} of ${session.totalQuestions}`}
    >
      <span className="practice-progress-label">
        {position} of {session.totalQuestions}
      </span>
      <span className="practice-segments">
        {segments.map((segment, index) => (
          <span
            key={index}
            className="practice-segment"
            data-current={segment.current}
            data-asked={segment.asked}
            style={
              segment.ratio !== null
                ? { background: scoreColor(segment.ratio) }
                : undefined
            }
          />
        ))}
      </span>
    </div>
  );
}

export function PracticeBar({
  session,
  onSessionChange,
  onRefresh,
}: {
  session: PracticeSession;
  onSessionChange: (session: PracticeSession) => void;
  onRefresh: () => Promise<void>;
}): ReactNode {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [masteryOpen, setMasteryOpen] = useState(false);
  const { progress } = session.options;
  const question = openQuestion(session);
  const score = runningScore(session.questions);
  const topics = progress.mastery ? topicMastery(session.questions) : [];
  const complete = session.status === "complete";

  const run = async (
    task: () => Promise<PracticeSession>,
    syncFirst: boolean,
  ): Promise<void> => {
    setError(null);
    if (syncFirst) {
      setBusy("syncing");
      try {
        // Claude grades a server render of the page, so it must hold every stroke first.
        await syncEngine.waitForNoteSynced(session.noteId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Sync failed.");
        setBusy(null);
        return;
      }
    }
    setBusy("sending");
    try {
      onSessionChange(await task());
    } catch (cause) {
      // 409: the question moved on elsewhere (another device or Claude); just catch up.
      if (!(cause instanceof ApiError && cause.status === 409)) {
        setError("Couldn't send that. Try again.");
      }
      void onRefresh();
    } finally {
      setBusy(null);
    }
  };

  let actions: ReactNode;
  if (complete) {
    actions = (
      <span className="practice-complete">
        <Check size={16} />
        Session complete
        {score !== null ? <ScoreText score={score} /> : null}
      </span>
    );
  } else if (question?.state === "awaiting_work") {
    actions = (
      <button
        type="button"
        className="primary practice-action"
        disabled={busy !== null}
        onClick={() =>
          void run(
            () =>
              submitPracticeQuestion(
                question.id,
                measureCardRegions(question.promptObjectId),
              ),
            true,
          )
        }
      >
        {busy !== null ? (
          <LoaderCircle size={16} className="practice-spin" />
        ) : (
          <Check size={16} />
        )}
        {busy === "syncing"
          ? "Syncing…"
          : busy === "sending"
            ? "Sending…"
            : "Done"}
      </button>
    );
  } else if (question?.state === "graded") {
    actions = (
      <>
        <button
          type="button"
          className="practice-action"
          disabled={busy !== null}
          onClick={() =>
            void run(() => sendPracticeAction(question.id, "retry"), false)
          }
        >
          <RotateCcw size={16} />
          Retry
        </button>
        <button
          type="button"
          className="primary practice-action"
          disabled={busy !== null}
          onClick={() =>
            void run(() => sendPracticeAction(question.id, "next"), false)
          }
        >
          Next
          <ArrowRight size={16} />
        </button>
      </>
    );
  } else {
    actions = (
      <button type="button" className="practice-action" disabled>
        <LoaderCircle size={16} className="practice-spin" />
        {question?.state === "submitted" ? "Grading…" : "Waiting…"}
      </button>
    );
  }

  // The bar sits under the canvas, so the expandable mastery list opens above its row.
  return (
    <section className="practice-bar" aria-label="Practice session">
      {masteryOpen && topics.length > 0 ? (
        <ul className="practice-mastery">
          {topics.map((topic) => (
            <li key={topic.topic}>
              <span className="practice-mastery-topic">{topic.topic}</span>
              <span className="practice-mastery-bar">
                <span
                  style={{
                    width: percent(topic.ratio),
                    background: scoreColor(topic.ratio),
                  }}
                />
              </span>
              <span className="practice-mastery-value">
                {percent(topic.ratio)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="practice-bar-row">
        <span className="practice-status" aria-live="polite">
          {progress.status ? (session.statusText ?? "") : ""}
        </span>
        {progress.bar ? <ProgressBar session={session} /> : null}
        {progress.runningScore && !complete && score !== null ? (
          <ScoreText score={score} />
        ) : null}
        {topics.length > 0 ? (
          <button
            type="button"
            className="ghost practice-topics-toggle"
            aria-expanded={masteryOpen}
            onClick={() => setMasteryOpen((open) => !open)}
          >
            Topics
            <ChevronDown size={16} />
          </button>
        ) : null}
        <div className="practice-actions">{actions}</div>
      </div>
      {error !== null ? (
        <button
          type="button"
          className="practice-error"
          role="alert"
          onClick={() => setError(null)}
        >
          {error}
        </button>
      ) : null}
    </section>
  );
}
