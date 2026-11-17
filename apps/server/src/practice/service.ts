// Guided-practice domain flows shared by the browser routes and the MCP tools: sessions, questions, grading, and the wait queue.
import crypto from "node:crypto";
import type pg from "pg";
import type {
  Bounds,
  PracticeAction,
  PracticeOptions,
  PracticeSession,
} from "@aurora/shared";
import { notFound } from "../errors.js";
import { withTransaction, getPool } from "../db/pool.js";
import { queryRegionalObjects } from "../canvas/objects.js";
import { resolveLocation, type PracticeLocation } from "./location.js";
import { createNote } from "../library/notes.js";
import { notifyPracticeEvent, waitForClaim } from "./events.js";
import {
  cardObject,
  markToObjects,
  practiceTagOf,
  type Mark,
} from "./marks.js";
import {
  CARD_WIDTH,
  CARD_X,
  CARD_Y,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  pageFrame,
} from "./page.js";
import {
  broadcastChanges,
  writeObjects,
  type ObjectChanges,
} from "./publish.js";
import { renderPagePng } from "./render.js";
import {
  checkCanFinish,
  checkFeedbackAllowed,
  nextQuestionIndex,
  planAction,
  planGrade,
  planSubmit,
  type QuestionFacts,
  type SessionFacts,
  type Transition,
} from "./state.js";
import {
  claimNextEvent,
  closeGradedQuestions,
  insertEvent,
  appendNotePage,
  insertQuestion,
  insertSession,
  listQuestions,
  loadLatestActiveSession,
  loadQuestion,
  loadSession,
  loadSessionByNote,
  mapSession,
  sessionOptions,
  updateQuestion,
  updateSession,
  type QuestionRow,
  type SessionRow,
} from "./store.js";

export type PlacedCard = Bounds & { html: string };

function sessionFacts(row: SessionRow): SessionFacts {
  return {
    status: row.status,
    totalQuestions: row.total_questions,
    options: sessionOptions(row),
  };
}

function questionFacts(row: QuestionRow): QuestionFacts {
  return {
    index: row.idx,
    state: row.state,
    attempt: row.attempt,
    maxPoints: Number(row.max_points),
    points: row.points === null ? null : Number(row.points),
  };
}

async function sessionState(
  client: pg.PoolClient | pg.Pool,
  session: SessionRow,
): Promise<PracticeSession> {
  const fresh = await loadSession(client, session.owner_id, session.id);
  return mapSession(fresh ?? session, await listQuestions(client, session.id));
}

// Locks the session row first (then the question) so every flow takes locks in one order.
async function withSession<T>(
  ownerId: string,
  sessionId: string,
  fn: (client: pg.PoolClient, session: SessionRow) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    const session = await loadSession(client, ownerId, sessionId, true);
    if (!session) throw notFound("Practice session");
    return fn(client, session);
  });
}

async function withQuestion<T>(
  ownerId: string,
  questionId: string,
  fn: (
    client: pg.PoolClient,
    session: SessionRow,
    question: QuestionRow,
  ) => Promise<T>,
): Promise<T> {
  const found = await loadQuestion(getPool(), ownerId, questionId);
  if (!found) throw notFound("Practice question");
  return withSession(ownerId, found.session_id, async (client, session) => {
    const question = await loadQuestion(client, ownerId, questionId, true);
    if (!question) throw notFound("Practice question");
    return fn(client, session, question);
  });
}

// Applies a browser-driven transition and queues its event for practice_wait.
async function applyTransition(
  client: pg.PoolClient,
  session: SessionRow,
  question: QuestionRow,
  transition: Transition,
): Promise<PracticeSession> {
  await updateQuestion(client, question.id, {
    state: transition.state,
    attempt: transition.attempt,
  });
  await updateSession(client, session.id, {
    statusText: transition.statusText,
  });
  await insertEvent(client, {
    session_id: session.id,
    question_id: question.id,
    type: transition.event,
    attempt: transition.attempt,
  });
  return sessionState(client, session);
}

async function runTransition(
  ownerId: string,
  questionId: string,
  plan: (session: SessionFacts, question: QuestionFacts) => Transition,
): Promise<PracticeSession> {
  const result = await withQuestion(
    ownerId,
    questionId,
    (client, session, question) =>
      applyTransition(
        client,
        session,
        question,
        plan(sessionFacts(session), questionFacts(question)),
      ),
  );
  broadcastChanges(ownerId, result.id, result.noteId);
  notifyPracticeEvent(result.id);
  return result;
}

// ---- Browser actions -------------------------------------------------------

export async function getSessionForNote(
  ownerId: string,
  noteId: string,
): Promise<PracticeSession> {
  const session = await loadSessionByNote(getPool(), ownerId, noteId);
  if (!session) throw notFound("Practice session");
  return sessionState(getPool(), session);
}

export function submitQuestion(
  ownerId: string,
  questionId: string,
): Promise<PracticeSession> {
  return runTransition(ownerId, questionId, planSubmit);
}

export function actOnQuestion(
  ownerId: string,
  questionId: string,
  action: PracticeAction["action"],
): Promise<PracticeSession> {
  return runTransition(ownerId, questionId, (session, question) =>
    planAction(session, question, action),
  );
}

// ---- Claude (MCP) actions ------------------------------------------------

export async function startSession(
  ownerId: string,
  input: {
    title: string;
    totalQuestions: number;
    options: PracticeOptions;
    location: PracticeLocation;
  },
): Promise<PracticeSession> {
  const { projectId, folderId } = await resolveLocation(
    ownerId,
    input.location,
  );
  const note = await createNote(ownerId, {
    projectId,
    folderId: folderId ?? undefined,
    title: input.title,
    canvasMode: "paged",
  });
  const session = await withTransaction((client) =>
    insertSession(client, ownerId, {
      noteId: note.id,
      title: input.title,
      totalQuestions: input.totalQuestions,
      options: input.options,
    }),
  );
  broadcastChanges(ownerId, session.id, note.id, undefined, true);
  return mapSession(session, []);
}

export async function getSession(
  ownerId: string,
  sessionId?: string,
): Promise<PracticeSession> {
  const session = sessionId
    ? await loadSession(getPool(), ownerId, sessionId)
    : await loadLatestActiveSession(getPool(), ownerId);
  if (!session) throw notFound("Practice session");
  return sessionState(getPool(), session);
}

async function commitObjects(
  ownerId: string,
  sessionId: string,
  fn: (
    client: pg.PoolClient,
    session: SessionRow,
  ) => Promise<{
    result: PracticeSession;
    changes?: ObjectChanges;
    pageAdded?: boolean;
  }>,
): Promise<PracticeSession> {
  const { result, changes, pageAdded } = await withSession(
    ownerId,
    sessionId,
    fn,
  );
  broadcastChanges(ownerId, result.id, result.noteId, changes, pageAdded);
  return result;
}

export async function postQuestion(
  ownerId: string,
  input: {
    sessionId: string;
    html: string;
    height: number;
    maxPoints: number;
    topics: string[];
  },
): Promise<{ questionId: string; session: PracticeSession }> {
  const questionId = crypto.randomUUID();
  const session = await commitObjects(
    ownerId,
    input.sessionId,
    async (client, session) => {
      const questions = await listQuestions(client, session.id);
      const index = nextQuestionIndex(
        sessionFacts(session),
        questions.map(questionFacts),
      );
      // The note starts with one page; later questions each get a new last page.
      const pageIndex =
        index === 0
          ? 0
          : await appendNotePage(client, ownerId, session.note_id);
      const prompt = cardObject(
        { ownerId, noteId: session.note_id, pageIndex },
        "prompt",
        input.html,
        { x: CARD_X, y: CARD_Y, width: CARD_WIDTH, height: input.height },
        { questionId, attempt: 1, role: "prompt" },
      );
      const changes = await writeObjects(client, ownerId, session.note_id, [
        prompt,
      ]);
      await insertQuestion(client, {
        id: questionId,
        sessionId: session.id,
        ownerId,
        index,
        pageIndex,
        maxPoints: input.maxPoints,
        topics: input.topics,
        promptObjectId: prompt.id,
      });
      await updateSession(client, session.id, { statusText: null });
      return {
        result: await sessionState(client, session),
        changes,
        pageAdded: index > 0,
      };
    },
  );
  return { questionId, session };
}

export async function gradeQuestion(
  ownerId: string,
  input: {
    questionId: string;
    points: number;
    marks: Mark[];
    feedback?: PlacedCard | undefined;
    solution?: PlacedCard | undefined;
    statusText?: string | undefined;
  },
): Promise<PracticeSession> {
  const found = await loadQuestion(getPool(), ownerId, input.questionId);
  if (!found) throw notFound("Practice question");
  return commitObjects(ownerId, found.session_id, async (client, session) => {
    const question = await loadQuestion(
      client,
      ownerId,
      input.questionId,
      true,
    );
    if (!question) throw notFound("Practice question");
    checkFeedbackAllowed(sessionOptions(session), {
      marks: input.marks.length,
      card: input.feedback !== undefined,
      solution: input.solution !== undefined,
    });
    const scores = planGrade(questionFacts(question), input.points);

    const ctx = {
      ownerId,
      noteId: session.note_id,
      pageIndex: question.page_index,
    };
    const tag = { questionId: question.id, attempt: question.attempt };
    const inserts = input.marks.flatMap((mark) =>
      markToObjects(ctx, mark, question.id, question.attempt),
    );
    if (input.feedback) {
      const { html, ...bounds } = input.feedback;
      inserts.push(
        cardObject(ctx, "feedback", html, bounds, { ...tag, role: "feedback" }),
      );
    }
    if (input.solution) {
      const { html, ...bounds } = input.solution;
      inserts.push(
        cardObject(ctx, "solution", html, bounds, { ...tag, role: "solution" }),
      );
    }
    // Replace every earlier attempt's marks and cards for this question; the prompt stays.
    const page = await queryRegionalObjects(ownerId, {
      noteId: session.note_id,
      viewport: pageFrame(question.page_index),
    });
    const stale = page.objects
      .filter((object) => {
        const objectTag = practiceTagOf(object);
        return (
          objectTag?.questionId === question.id && objectTag.role !== "prompt"
        );
      })
      .map((object) => object.id);

    const changes = await writeObjects(
      client,
      ownerId,
      session.note_id,
      inserts,
      stale,
    );
    await updateQuestion(client, question.id, { state: "graded", ...scores });
    await updateSession(client, session.id, {
      statusText: input.statusText ?? null,
    });
    return { result: await sessionState(client, session), changes };
  });
}

export function setStatus(
  ownerId: string,
  sessionId: string,
  text: string | null,
): Promise<PracticeSession> {
  return commitObjects(ownerId, sessionId, async (client, session) => {
    await updateSession(client, session.id, { statusText: text });
    return { result: await sessionState(client, session) };
  });
}

export function finishSession(
  ownerId: string,
  input: { sessionId: string; summaryHtml: string; height: number },
): Promise<PracticeSession> {
  return commitObjects(ownerId, input.sessionId, async (client, session) => {
    const questions = await listQuestions(client, session.id);
    checkCanFinish(sessionFacts(session), questions.map(questionFacts));
    const pageIndex = await appendNotePage(client, ownerId, session.note_id);
    const summary = cardObject(
      { ownerId, noteId: session.note_id, pageIndex },
      "summary",
      input.summaryHtml,
      { x: CARD_X, y: CARD_Y, width: CARD_WIDTH, height: input.height },
      { questionId: null, attempt: 1, role: "summary" },
    );
    const changes = await writeObjects(client, ownerId, session.note_id, [
      summary,
    ]);
    await closeGradedQuestions(client, session.id);
    await updateSession(client, session.id, {
      status: "complete",
      statusText: null,
    });
    return {
      result: await sessionState(client, session),
      changes,
      pageAdded: true,
    };
  });
}

// ---- Submission image and wait queue --------------------------------------

export type SubmissionMeta = {
  questionId: string;
  index: number;
  attempt: number;
  maxPoints: number;
  topics: string[];
  pageSize: { width: number; height: number };
};

export async function renderSubmission(
  ownerId: string,
  questionId: string,
): Promise<{ meta: SubmissionMeta; png: Buffer }> {
  const question = await loadQuestion(getPool(), ownerId, questionId);
  if (!question) throw notFound("Practice question");
  const session = await loadSession(getPool(), ownerId, question.session_id);
  if (!session) throw notFound("Practice session");
  const page = await queryRegionalObjects(ownerId, {
    noteId: session.note_id,
    viewport: pageFrame(question.page_index),
  });
  const png = await renderPagePng(page.objects, {
    pageIndex: question.page_index,
    attempt: question.attempt,
  });
  return {
    meta: {
      questionId: question.id,
      index: question.idx,
      attempt: question.attempt,
      maxPoints: Number(question.max_points),
      topics: question.topics,
      pageSize: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
    },
    png,
  };
}

export type WaitResult =
  | { event: "timeout" }
  | ({ event: "submitted"; png: Buffer } & SubmissionMeta)
  | {
      event: "next";
      questionId: string;
      index: number;
      questionsPosted: number;
      totalQuestions: number;
    }
  | { event: "retry"; questionId: string; index: number; attempt: number };

export async function waitForEvent(
  ownerId: string,
  sessionId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WaitResult> {
  const session = await loadSession(getPool(), ownerId, sessionId);
  if (!session) throw notFound("Practice session");
  const event = await waitForClaim(
    sessionId,
    timeoutMs,
    () => claimNextEvent(getPool(), sessionId),
    signal,
  );
  if (!event) return { event: "timeout" };
  if (event.type === "submitted") {
    const { meta, png } = await renderSubmission(ownerId, event.question_id);
    return { event: "submitted", ...meta, attempt: event.attempt, png };
  }
  const question = await loadQuestion(getPool(), ownerId, event.question_id);
  const index = question?.idx ?? -1;
  if (event.type === "retry") {
    return {
      event: "retry",
      questionId: event.question_id,
      index,
      attempt: event.attempt,
    };
  }
  const questions = await listQuestions(getPool(), sessionId);
  return {
    event: "next",
    questionId: event.question_id,
    index,
    questionsPosted: questions.length,
    totalQuestions: session.total_questions,
  };
}
