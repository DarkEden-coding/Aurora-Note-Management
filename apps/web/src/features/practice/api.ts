// Practice HTTP surface for the browser: load a note's session, submit the open question (with its measured card layout), and choose Next/Retry. Responses are validated with the shared schemas.
import {
  practiceSessionSchema,
  type PracticeAction,
  type PracticeCardRegion,
  type PracticeSession,
  type PracticeSubmit,
} from "@aurora/shared";
import { ApiError, api, apiPost } from "../../lib/http.js";

/** The note's practice session, or null when the note has none (404). */
export async function fetchPracticeSession(
  noteId: string,
): Promise<PracticeSession | null> {
  try {
    return practiceSessionSchema.parse(
      await api<unknown>(`/api/practice/notes/${encodeURIComponent(noteId)}`),
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function submitPracticeQuestion(
  questionId: string,
  regions?: PracticeCardRegion[],
): Promise<PracticeSession> {
  const body: PracticeSubmit = regions ? { regions } : {};
  return practiceSessionSchema.parse(
    await apiPost<unknown>(
      `/api/practice/questions/${encodeURIComponent(questionId)}/submit`,
      body,
    ),
  );
}

export async function sendPracticeAction(
  questionId: string,
  action: PracticeAction["action"],
): Promise<PracticeSession> {
  const body: PracticeAction = { action };
  return practiceSessionSchema.parse(
    await apiPost<unknown>(
      `/api/practice/questions/${encodeURIComponent(questionId)}/action`,
      body,
    ),
  );
}
