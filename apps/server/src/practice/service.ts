// Guided-practice domain flows shared by the browser routes and the MCP tools: sessions, questions, grading, and the wait queue.
import crypto from "node:crypto";
import type pg from "pg";
import type {
  Bounds,
  CanvasObject,
  PracticeAction,
  PracticeCardRegion,
  PracticeGrading,
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
import type { PracticeTag } from "./marks.js";
import {
  broadcastChanges,
  writeObjects,
  type ObjectChanges,
} from "./publish.js";
import {
  describePage,
  renderPageImages,
  type ImageOptions,
  type PageGeometry,
  type PageImage,
} from "./submission.js";
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
  questionRegions,
  sessionGrading,
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
  cardRegions?: PracticeCardRegion[],
): Promise<PracticeSession> {
  await updateQuestion(client, question.id, {
    state: transition.state,
    attempt: transition.attempt,
    cardRegions,
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
  cardRegions?: PracticeCardRegion[],
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
        cardRegions,
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

/** Done pressed; `cardRegions` is the card layout the browser measured (absent from older clients). */
export function submitQuestion(
  ownerId: string,
  questionId: string,
  cardRegions?: PracticeCardRegion[],
): Promise<PracticeSession> {
  return runTransition(ownerId, questionId, planSubmit, cardRegions);
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
    grading: PracticeGrading | null;
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
      grading: input.grading,
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

export type GradeInput = {
  questionId: string;
  points: number;
  marks: Mark[];
  feedback?: PlacedCard | undefined;
  solution?: PlacedCard | undefined;
  statusText?: string | undefined;
};

// New mark/card objects for a grade, and the ids of the earlier ones on that page it replaces (the prompt stays).
function gradeObjects(
  ownerId: string,
  session: SessionRow,
  question: QuestionRow,
  input: GradeInput,
  pageObjects: CanvasObject[],
): { inserts: CanvasObject[]; stale: string[] } {
  checkFeedbackAllowed(sessionOptions(session), {
    marks: input.marks.length,
    card: input.feedback !== undefined,
    solution: input.solution !== undefined,
  });
  const ctx = {
    ownerId,
    noteId: session.note_id,
    pageIndex: question.page_index,
  };
  const tag = { questionId: question.id, attempt: question.attempt };
  const inserts = input.marks.flatMap((mark) =>
    markToObjects(ctx, mark, question.id, question.attempt),
  );
  const cards: Array<[PlacedCard | undefined, "feedback" | "solution"]> = [
    [input.feedback, "feedback"],
    [input.solution, "solution"],
  ];
  for (const [card, role] of cards) {
    if (!card) continue;
    const { html, ...bounds } = card;
    const practice: PracticeTag = { ...tag, role };
    inserts.push(cardObject(ctx, role, html, bounds, practice));
  }
  const stale = pageObjects
    .filter((object) => {
      const objectTag = practiceTagOf(object);
      return (
        objectTag?.questionId === question.id && objectTag.role !== "prompt"
      );
    })
    .map((object) => object.id);
  return { inserts, stale };
}

function loadPageObjects(
  ownerId: string,
  noteId: string,
  pageIndex: number,
): Promise<CanvasObject[]> {
  return queryRegionalObjects(ownerId, {
    noteId,
    viewport: pageFrame(pageIndex),
  }).then((page) => page.objects);
}

/**
 * Grades a submitted question, or re-grades a graded one before the user presses Next/Retry.
 * Either way the question's earlier marks and cards are replaced by these.
 */
export async function gradeQuestion(
  ownerId: string,
  input: GradeInput,
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
    const scores = planGrade(questionFacts(question), input.points);
    const { inserts, stale } = gradeObjects(
      ownerId,
      session,
      question,
      input,
      await loadPageObjects(ownerId, session.note_id, question.page_index),
    );
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

/** Renders the page as it would look after this grade, without saving anything. */
export async function previewGrade(
  ownerId: string,
  input: GradeInput,
  image: ImageOptions,
): Promise<{ meta: SubmissionMeta; images: PageImage[] }> {
  const { session, question } = await loadQuestionWithSession(
    ownerId,
    input.questionId,
  );
  planGrade(questionFacts(question), input.points);
  const pageObjects = await loadPageObjects(
    ownerId,
    session.note_id,
    question.page_index,
  );
  const { inserts, stale } = gradeObjects(
    ownerId,
    session,
    question,
    input,
    pageObjects,
  );
  const objects = [
    ...pageObjects.filter((object) => !stale.includes(object.id)),
    ...inserts,
  ];
  return renderPage(session, question, objects, image);
}

export function setGrading(
  ownerId: string,
  sessionId: string,
  grading: PracticeGrading | null,
): Promise<PracticeSession> {
  return commitObjects(ownerId, sessionId, async (client, session) => {
    await updateSession(client, session.id, { grading });
    return { result: await sessionState(client, session) };
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
  grading: PracticeGrading | null;
  // The page area the main image shows and its pixels per page unit (crop/scale options).
  image: PageImage["area"];
  // Present when the card has a .final-answer box: the second image is a close-up of it.
  finalAnswerImage?: PageImage["area"];
} & PageGeometry;

async function loadQuestionWithSession(
  ownerId: string,
  questionId: string,
): Promise<{ session: SessionRow; question: QuestionRow }> {
  const question = await loadQuestion(getPool(), ownerId, questionId);
  if (!question) throw notFound("Practice question");
  const session = await loadSession(getPool(), ownerId, question.session_id);
  if (!session) throw notFound("Practice session");
  return { session, question };
}

async function renderPage(
  session: SessionRow,
  question: QuestionRow,
  objects: CanvasObject[],
  image: ImageOptions,
): Promise<{ meta: SubmissionMeta; images: PageImage[] }> {
  const geometry = describePage(
    objects,
    question.page_index,
    questionRegions(question),
  );
  const { page, finalAnswer } = await renderPageImages(
    objects,
    { pageIndex: question.page_index, attempt: question.attempt },
    geometry,
    image,
  );
  return {
    meta: {
      questionId: question.id,
      index: question.idx,
      attempt: question.attempt,
      maxPoints: Number(question.max_points),
      topics: question.topics,
      pageSize: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
      grading: sessionGrading(session),
      image: page.area,
      ...(finalAnswer ? { finalAnswerImage: finalAnswer.area } : {}),
      ...geometry,
    },
    images: finalAnswer ? [page, finalAnswer] : [page],
  };
}

export async function renderSubmission(
  ownerId: string,
  questionId: string,
  image: ImageOptions,
): Promise<{ meta: SubmissionMeta; images: PageImage[] }> {
  const { session, question } = await loadQuestionWithSession(
    ownerId,
    questionId,
  );
  const objects = await loadPageObjects(
    ownerId,
    session.note_id,
    question.page_index,
  );
  return renderPage(session, question, objects, image);
}

export type WaitResult =
  | { event: "timeout" }
  | ({ event: "submitted"; images: PageImage[] } & SubmissionMeta)
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
  image: ImageOptions,
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
    const { meta, images } = await renderSubmission(
      ownerId,
      event.question_id,
      image,
    );
    return { event: "submitted", ...meta, attempt: event.attempt, images };
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
