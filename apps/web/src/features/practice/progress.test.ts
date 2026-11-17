// Verifies practice header math: graded-only score and mastery aggregation, segment states, score colours, and the page to focus.
import { describe, expect, it } from "vitest";
import type { PracticeQuestion, PracticeSession } from "@aurora/shared";
import {
  focusPageIndex,
  progressSegments,
  runningScore,
  scoreColor,
  topicMastery,
} from "./progress";

function question(
  index: number,
  patch: Partial<PracticeQuestion> = {},
): PracticeQuestion {
  return {
    id: `00000000-0000-4000-8000-00000000000${index}`,
    index,
    pageIndex: index,
    state: "closed",
    attempt: 1,
    maxPoints: 4,
    points: 4,
    latestPoints: 4,
    topics: [],
    ...patch,
  };
}

function session(
  questions: PracticeQuestion[],
  patch: Partial<PracticeSession> = {},
): PracticeSession {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    noteId: "00000000-0000-4000-8000-0000000000b1",
    title: "Derivatives",
    totalQuestions: 4,
    status: "active",
    statusText: null,
    options: {
      feedback: { inkMarks: true, card: false, solution: false, retry: true },
      progress: { bar: true, runningScore: true, mastery: true, status: true },
    },
    questions,
    updatedAt: "2026-11-17T10:00:00.000Z",
    ...patch,
  };
}

describe("practice progress", () => {
  const questions = [
    question(0, { points: 1, latestPoints: 3, topics: ["chain rule"] }),
    question(1, { points: 4, topics: ["chain rule", "product rule"] }),
    question(2, {
      state: "submitted",
      points: null,
      latestPoints: null,
      topics: ["product rule"],
    }),
  ];

  it("scores only graded questions by first-attempt points", () => {
    expect(runningScore(questions)).toEqual({
      points: 5,
      maxPoints: 8,
      ratio: 5 / 8,
    });
    expect(runningScore([question(0, { points: null })])).toBeNull();
    expect(topicMastery(questions)).toEqual([
      { topic: "chain rule", points: 5, maxPoints: 8, ratio: 5 / 8 },
      { topic: "product rule", points: 4, maxPoints: 4, ratio: 1 },
    ]);
  });

  it("colours finished segments by latest score and outlines the open question", () => {
    expect(progressSegments(session(questions))).toEqual([
      { ratio: 0.75, current: false, asked: true },
      { ratio: 1, current: false, asked: true },
      { ratio: null, current: true, asked: true },
      { ratio: null, current: false, asked: false },
    ]);
    // Between questions the next, not yet written, segment is current.
    expect(
      progressSegments(session(questions.slice(0, 2))).map((s) => s.current),
    ).toEqual([false, false, true, false]);
  });

  it("maps scores from red through amber to green", () => {
    expect(scoreColor(0)).toBe("hsl(0 72% 56%)");
    expect(scoreColor(0.5)).toBe("hsl(38 72% 56%)");
    expect(scoreColor(1)).toBe("hsl(130 72% 56%)");
    expect(scoreColor(2)).toBe(scoreColor(1));
  });

  it("focuses the latest question page, then the summary page", () => {
    expect(focusPageIndex(session([]))).toBeNull();
    expect(focusPageIndex(session(questions))).toBe(2);
    expect(
      focusPageIndex(session(questions.slice(0, 2), { status: "complete" })),
    ).toBe(2);
  });
});
