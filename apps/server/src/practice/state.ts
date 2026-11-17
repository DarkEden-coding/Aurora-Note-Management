// Pure guided-practice state rules: which transitions are allowed and what each one changes and queues.
import type {
  PracticeAction,
  PracticeOptions,
  PracticeQuestionState,
} from "@aurora/shared";
import { conflict, invalid } from "../errors.js";
import type { PracticeEventType } from "./store.js";

export type QuestionFacts = {
  index: number;
  state: PracticeQuestionState;
  attempt: number;
  maxPoints: number;
  points: number | null;
};

export type SessionFacts = {
  status: "active" | "complete";
  totalQuestions: number;
  options: PracticeOptions;
};

export type Transition = {
  state: PracticeQuestionState;
  attempt: number;
  statusText: string | null;
  event: PracticeEventType;
};

function requireActive(session: SessionFacts): void {
  if (session.status !== "active") {
    throw conflict("This practice session is already complete");
  }
}

function requireState(
  question: QuestionFacts,
  expected: PracticeQuestionState,
): void {
  if (question.state !== expected) {
    throw conflict(
      `Question ${question.index + 1} is ${question.state}; this needs ${expected}`,
    );
  }
}

/** The user pressed Done. */
export function planSubmit(
  session: SessionFacts,
  question: QuestionFacts,
): Transition {
  requireActive(session);
  requireState(question, "awaiting_work");
  return {
    state: "submitted",
    attempt: question.attempt,
    statusText: "Grading…",
    event: "submitted",
  };
}

/** The user pressed Next or Retry on a graded question. */
export function planAction(
  session: SessionFacts,
  question: QuestionFacts,
  action: PracticeAction["action"],
): Transition {
  requireActive(session);
  requireState(question, "graded");
  if (action === "retry") {
    if (!session.options.feedback.retry) {
      throw conflict("Retries are not enabled for this session");
    }
    return {
      state: "awaiting_work",
      attempt: question.attempt + 1,
      statusText: null,
      event: "retry",
    };
  }
  const isLast = question.index >= session.totalQuestions - 1;
  return {
    state: "closed",
    attempt: question.attempt,
    statusText: isLast ? "Writing your summary…" : "Writing the next question…",
    event: "next",
  };
}

/** Index for the next question; only allowed when every earlier question is closed. */
export function nextQuestionIndex(
  session: SessionFacts,
  questions: QuestionFacts[],
): number {
  requireActive(session);
  const open = questions.find((q) => q.state !== "closed");
  if (open) {
    throw conflict(
      `Question ${open.index + 1} is still ${open.state}; wait for the user's "next" event first`,
    );
  }
  if (questions.length >= session.totalQuestions) {
    throw conflict(
      `All ${session.totalQuestions} questions were posted; call practice_finish`,
    );
  }
  return questions.length;
}

/** Score columns after grading: `points` is fixed by the first attempt, `latestPoints` follows every attempt. */
export function planGrade(
  question: QuestionFacts,
  points: number,
): { points: number | null; latestPoints: number } {
  requireState(question, "submitted");
  if (points > question.maxPoints) {
    throw invalid(
      `points (${points}) exceeds maxPoints (${question.maxPoints}) for this question`,
    );
  }
  return {
    points: question.attempt === 1 ? points : question.points,
    latestPoints: points,
  };
}

/** Grading feedback must match the affordances the session enabled. */
export function checkFeedbackAllowed(
  options: PracticeOptions,
  feedback: { marks: number; card: boolean; solution: boolean },
): void {
  if (feedback.marks > 0 && !options.feedback.inkMarks) {
    throw invalid("Ink marks are disabled for this session; send marks: []");
  }
  if (feedback.card && !options.feedback.card) {
    throw invalid("Feedback cards are disabled for this session");
  }
  if (feedback.solution && !options.feedback.solution) {
    throw invalid("Solution cards are disabled for this session");
  }
}

/** Finishing needs every question past grading (graded ones are closed by the finish). */
export function checkCanFinish(
  session: SessionFacts,
  questions: QuestionFacts[],
): void {
  requireActive(session);
  const pending = questions.find(
    (q) => q.state === "awaiting_work" || q.state === "submitted",
  );
  if (pending) {
    throw conflict(
      `Question ${pending.index + 1} is still ${pending.state}; grade it before finishing`,
    );
  }
}
