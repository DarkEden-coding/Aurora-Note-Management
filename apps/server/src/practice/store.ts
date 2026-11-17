// Owns practice SQL: session and question rows, their wire mapping, and the persisted practice event queue.
import pg from "pg";
import {
  practiceOptionsSchema,
  practiceSessionSchema,
  type PracticeOptions,
  type PracticeQuestionState,
  type PracticeSession,
} from "@aurora/shared";

export type Db = pg.Pool | pg.PoolClient;

export type SessionRow = {
  id: string;
  owner_id: string;
  note_id: string;
  title: string;
  total_questions: number;
  status: "active" | "complete";
  status_text: string | null;
  options: unknown;
  updated_at: Date;
};

export type QuestionRow = {
  id: string;
  session_id: string;
  owner_id: string;
  idx: number;
  page_index: number;
  state: PracticeQuestionState;
  attempt: number;
  max_points: string;
  points: string | null;
  latest_points: string | null;
  topics: string[];
  prompt_object_id: string | null;
};

export type PracticeEventType = "submitted" | "next" | "retry";

export type EventRow = {
  id: string;
  session_id: string;
  question_id: string;
  type: PracticeEventType;
  attempt: number;
};

const SESSION_COLUMNS =
  "id, owner_id, note_id, title, total_questions, status, status_text, options, updated_at";
const QUESTION_COLUMNS =
  "id, session_id, owner_id, idx, page_index, state, attempt, max_points, points, latest_points, topics, prompt_object_id";

const toNumber = (value: string | null): number | null =>
  value === null ? null : Number(value);

export function sessionOptions(row: SessionRow): PracticeOptions {
  return practiceOptionsSchema.parse(row.options ?? {});
}

export function mapSession(
  row: SessionRow,
  questions: QuestionRow[],
): PracticeSession {
  return practiceSessionSchema.parse({
    id: row.id,
    noteId: row.note_id,
    title: row.title,
    totalQuestions: row.total_questions,
    status: row.status,
    statusText: row.status_text,
    options: sessionOptions(row),
    questions: questions.map((q) => ({
      id: q.id,
      index: q.idx,
      pageIndex: q.page_index,
      state: q.state,
      attempt: q.attempt,
      maxPoints: Number(q.max_points),
      points: toNumber(q.points),
      latestPoints: toNumber(q.latest_points),
      topics: q.topics,
    })),
    updatedAt: row.updated_at.toISOString(),
  });
}

export async function insertSession(
  db: Db,
  ownerId: string,
  input: {
    noteId: string;
    title: string;
    totalQuestions: number;
    options: PracticeOptions;
  },
): Promise<SessionRow> {
  const result = await db.query<SessionRow>(
    `INSERT INTO practice_sessions (owner_id, note_id, title, total_questions, options)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${SESSION_COLUMNS}`,
    [
      ownerId,
      input.noteId,
      input.title,
      input.totalQuestions,
      JSON.stringify(input.options),
    ],
  );
  return result.rows[0]!;
}

export async function loadSession(
  db: Db,
  ownerId: string,
  sessionId: string,
  lock = false,
): Promise<SessionRow | null> {
  const result = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM practice_sessions
     WHERE owner_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [ownerId, sessionId],
  );
  return result.rows[0] ?? null;
}

export async function loadSessionByNote(
  db: Db,
  ownerId: string,
  noteId: string,
): Promise<SessionRow | null> {
  const result = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM practice_sessions WHERE owner_id = $1 AND note_id = $2`,
    [ownerId, noteId],
  );
  return result.rows[0] ?? null;
}

export async function loadLatestActiveSession(
  db: Db,
  ownerId: string,
): Promise<SessionRow | null> {
  const result = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM practice_sessions
     WHERE owner_id = $1 AND status = 'active'
     ORDER BY updated_at DESC LIMIT 1`,
    [ownerId],
  );
  return result.rows[0] ?? null;
}

export async function updateSession(
  db: Db,
  sessionId: string,
  fields: { status?: "active" | "complete"; statusText?: string | null },
): Promise<void> {
  const assignments = ["updated_at = now()"];
  const params: unknown[] = [sessionId];
  if (fields.status !== undefined) {
    params.push(fields.status);
    assignments.push(`status = $${params.length}`);
  }
  if (fields.statusText !== undefined) {
    params.push(fields.statusText);
    assignments.push(`status_text = $${params.length}`);
  }
  await db.query(
    `UPDATE practice_sessions SET ${assignments.join(", ")} WHERE id = $1`,
    params,
  );
}

export async function listQuestions(
  db: Db,
  sessionId: string,
): Promise<QuestionRow[]> {
  const result = await db.query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM practice_questions WHERE session_id = $1 ORDER BY idx`,
    [sessionId],
  );
  return result.rows;
}

export async function loadQuestion(
  db: Db,
  ownerId: string,
  questionId: string,
  lock = false,
): Promise<QuestionRow | null> {
  const result = await db.query<QuestionRow>(
    `SELECT ${QUESTION_COLUMNS} FROM practice_questions
     WHERE owner_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [ownerId, questionId],
  );
  return result.rows[0] ?? null;
}

export async function insertQuestion(
  db: Db,
  input: {
    id: string;
    sessionId: string;
    ownerId: string;
    index: number;
    pageIndex: number;
    maxPoints: number;
    topics: string[];
    promptObjectId: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO practice_questions
       (id, session_id, owner_id, idx, page_index, max_points, topics, prompt_object_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.sessionId,
      input.ownerId,
      input.index,
      input.pageIndex,
      input.maxPoints,
      input.topics,
      input.promptObjectId,
    ],
  );
}

export async function updateQuestion(
  db: Db,
  questionId: string,
  fields: {
    state?: PracticeQuestionState;
    attempt?: number;
    points?: number | null;
    latestPoints?: number | null;
  },
): Promise<void> {
  const columns: Array<[string, unknown]> = [
    ["state", fields.state],
    ["attempt", fields.attempt],
    ["points", fields.points],
    ["latest_points", fields.latestPoints],
  ];
  const assignments = ["updated_at = now()"];
  const params: unknown[] = [questionId];
  for (const [column, value] of columns) {
    if (value === undefined) continue;
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  }
  await db.query(
    `UPDATE practice_questions SET ${assignments.join(", ")} WHERE id = $1`,
    params,
  );
}

export async function closeGradedQuestions(
  db: Db,
  sessionId: string,
): Promise<void> {
  await db.query(
    `UPDATE practice_questions SET state = 'closed', updated_at = now()
     WHERE session_id = $1 AND state = 'graded'`,
    [sessionId],
  );
}

export async function insertEvent(
  db: Db,
  event: Omit<EventRow, "id">,
): Promise<void> {
  await db.query(
    `INSERT INTO practice_events (session_id, question_id, type, attempt)
     VALUES ($1, $2, $3, $4)`,
    [event.session_id, event.question_id, event.type, event.attempt],
  );
}

// Atomically consumes the oldest pending event; SKIP LOCKED keeps concurrent waiters from taking the same row.
export async function claimNextEvent(
  db: Db,
  sessionId: string,
): Promise<EventRow | null> {
  const result = await db.query<EventRow>(
    `UPDATE practice_events SET consumed_at = now()
     WHERE id = (
       SELECT id FROM practice_events
       WHERE session_id = $1 AND consumed_at IS NULL
       ORDER BY id LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, session_id, question_id, type, attempt`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

/** Appends a page after the note's last page, copying its size and background; returns the new index. */
export async function appendNotePage(
  db: Db,
  ownerId: string,
  noteId: string,
): Promise<number> {
  const result = await db.query<{ page_index: number }>(
    `INSERT INTO pages (owner_id, note_id, page_index, width, height, background)
     SELECT owner_id, note_id, page_index + 1, width, height, background
     FROM pages WHERE owner_id = $1 AND note_id = $2
     ORDER BY page_index DESC LIMIT 1
     RETURNING page_index`,
    [ownerId, noteId],
  );
  if (!result.rows[0]) throw new Error("Practice note has no pages");
  return result.rows[0].page_index;
}

/** Keeps questions on their pages when a page is inserted after `afterPageIndex`. */
export async function shiftPracticePages(
  db: Db,
  ownerId: string,
  noteId: string,
  afterPageIndex: number,
): Promise<void> {
  await db.query(
    `UPDATE practice_questions q SET page_index = q.page_index + 1, updated_at = now()
     FROM practice_sessions s
     WHERE q.session_id = s.id AND s.owner_id = $1 AND s.note_id = $2
       AND q.page_index > $3`,
    [ownerId, noteId, afterPageIndex],
  );
}
