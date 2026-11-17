// Loads the open note's practice session and keeps it current: refetches on practice-changed broadcasts for the note and after the sync socket reconnects.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PracticeSession } from "@aurora/shared";
import { syncEngine } from "../../sync/engine.js";
import { fetchPracticeSession } from "./api.js";

export interface PracticeSessionHandle {
  session: PracticeSession | null;
  /** Refetch from the server; failures keep the last known state. */
  refresh: () => Promise<void>;
  /** Adopt a session returned by a practice POST. */
  apply: (session: PracticeSession) => void;
}

interface State {
  noteId: string;
  session: PracticeSession | null;
}

/** Keep the newer of two snapshots so a slow response never rolls the header back. */
function newer(state: State, next: State): State {
  if (
    state.noteId === next.noteId &&
    state.session !== null &&
    next.session !== null &&
    state.session.id === next.session.id &&
    Date.parse(state.session.updatedAt) > Date.parse(next.session.updatedAt)
  ) {
    return state;
  }
  return next;
}

export function usePracticeSession(noteId: string): PracticeSessionHandle {
  const [state, setState] = useState<State>({ noteId, session: null });
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

  const refresh = useCallback(async () => {
    try {
      const session = await fetchPracticeSession(noteId);
      if (noteIdRef.current !== noteId) return;
      setState((current) => newer(current, { noteId, session }));
    } catch {
      // Offline or server error: the next broadcast or reconnect refetches.
    }
  }, [noteId]);

  const apply = useCallback((session: PracticeSession) => {
    if (noteIdRef.current !== session.noteId) return;
    setState((current) => newer(current, { noteId: session.noteId, session }));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      syncEngine.onPracticeChanged((event) => {
        if (event.noteId === noteId) void refresh();
      }),
    [noteId, refresh],
  );

  // Broadcasts sent while the socket was down are lost; catch up on reconnect.
  useEffect(() => {
    let previous = syncEngine.getStatus().state;
    return syncEngine.subscribe(() => {
      const next = syncEngine.getStatus().state;
      if (next === "open" && previous !== "open") void refresh();
      previous = next;
    });
  }, [refresh]);

  return {
    session: state.noteId === noteId ? state.session : null,
    refresh,
    apply,
  };
}
