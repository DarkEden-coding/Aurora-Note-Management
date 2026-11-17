// Pure practice-progress math for the header: current question, segment states, running score, per-topic mastery, score colours, and the page to focus.
import type { PracticeQuestion, PracticeSession } from "@aurora/shared";

export interface Score {
  points: number;
  maxPoints: number;
  ratio: number;
}

export interface TopicScore extends Score {
  topic: string;
}

export interface ProgressSegment {
  /** latestPoints / maxPoints once graded; null while ungraded or not asked yet. */
  ratio: number | null;
  current: boolean;
  /** The question exists (asked) even if it is not graded yet. */
  asked: boolean;
}

/** The question the user is working on, if one is open. */
export function openQuestion(
  session: PracticeSession,
): PracticeQuestion | null {
  let open: PracticeQuestion | null = null;
  for (const question of session.questions) {
    if (question.state !== "closed" && question.index >= (open?.index ?? -1)) {
      open = question;
    }
  }
  return open;
}

/** Zero-based index of the current question; the next one while Claude writes it. */
export function currentQuestionIndex(session: PracticeSession): number | null {
  if (session.status === "complete") return null;
  const open = openQuestion(session);
  if (open !== null) return open.index;
  return session.questions.length < session.totalQuestions
    ? session.questions.length
    : null;
}

export function progressSegments(session: PracticeSession): ProgressSegment[] {
  const current = currentQuestionIndex(session);
  const byIndex = new Map(session.questions.map((q) => [q.index, q]));
  return Array.from({ length: session.totalQuestions }, (_, index) => {
    const question = byIndex.get(index);
    return {
      ratio:
        question?.latestPoints != null
          ? question.latestPoints / question.maxPoints
          : null,
      current: index === current,
      asked: question !== undefined,
    };
  });
}

/** Σ first-attempt points over Σ max points of graded questions. */
export function runningScore(questions: PracticeQuestion[]): Score | null {
  let points = 0;
  let maxPoints = 0;
  for (const question of questions) {
    if (question.points === null) continue;
    points += question.points;
    maxPoints += question.maxPoints;
  }
  return maxPoints > 0
    ? { points, maxPoints, ratio: points / maxPoints }
    : null;
}

/** Graded points per topic, in the order topics first appear. */
export function topicMastery(questions: PracticeQuestion[]): TopicScore[] {
  const totals = new Map<string, { points: number; maxPoints: number }>();
  for (const question of questions) {
    if (question.points === null) continue;
    for (const topic of question.topics) {
      const total = totals.get(topic) ?? { points: 0, maxPoints: 0 };
      total.points += question.points;
      total.maxPoints += question.maxPoints;
      totals.set(topic, total);
    }
  }
  return [...totals].map(([topic, total]) => ({
    topic,
    ...total,
    ratio: total.points / total.maxPoints,
  }));
}

/** Red (0) → amber (0.5) → green (1) for a score ratio. */
export function scoreColor(ratio: number): string {
  const clamped = Math.min(1, Math.max(0, ratio));
  const hue =
    clamped <= 0.5 ? clamped * 2 * 38 : 38 + (clamped - 0.5) * 2 * (130 - 38);
  return `hsl(${Math.round(hue)} 72% 56%)`;
}

export function formatPoints(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Page the canvas should show: the latest question, or the summary page once complete. */
export function focusPageIndex(session: PracticeSession): number | null {
  const last = session.questions.reduce<PracticeQuestion | null>(
    (latest, question) =>
      latest === null || question.index > latest.index ? question : latest,
    null,
  );
  if (session.status === "complete") return (last?.pageIndex ?? -1) + 1;
  return last?.pageIndex ?? null;
}
