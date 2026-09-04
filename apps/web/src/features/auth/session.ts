// This module tracks Aurora's browser session state: it asks the server on boot (the cookie is the only authority) and exposes the authenticated/unauthenticated decision plus logout to the shell.
import { useEffect, useRef, useState } from "react";
import type { DrawingPalette } from "@aurora/shared";
import { api, apiPatch, apiPost } from "../../lib/http.js";

export type SessionState = "checking" | "authenticated" | "unauthenticated";

interface SessionResponse {
  authenticated: boolean;
  ownerId: string;
  sessionId: string;
  enrolled: boolean;
  theme: "neomorphic" | "glass" | "minimal";
  drawingPalette: DrawingPalette;
}

export function useSession(): {
  state: SessionState;
  ownerId: string | null;
  userLabel: string | null;
  drawingPalette: DrawingPalette;
  /** Optimistically persists the account palette, rejecting with a user-safe error on failure. */
  updateDrawingPalette: (drawingPalette: DrawingPalette) => Promise<void>;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<SessionState>("checking");
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [userLabel, setUserLabel] = useState<string | null>(null);
  const [drawingPalette, setDrawingPalette] = useState<DrawingPalette>([
    "#000000",
  ]);
  const paletteRef = useRef<DrawingPalette>(["#000000"]);
  const paletteRequestRef = useRef(0);
  // Serialize writes so rapid drag reorders cannot arrive at the server out of order.
  const paletteSaveQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  const refresh = async () => {
    try {
      const session = await api<SessionResponse>("/api/auth/session");
      setState(session.authenticated ? "authenticated" : "unauthenticated");
      setOwnerId(session.ownerId);
      setUserLabel(session.enrolled ? "Passkey owner" : null);
      paletteRef.current = session.drawingPalette;
      setDrawingPalette(session.drawingPalette);
      // Theme convergence: devices without a local choice adopt the account theme.
      if (
        session.authenticated &&
        !localStorage.getItem("aurora.theme") &&
        session.theme
      ) {
        window.dispatchEvent(
          new CustomEvent("aurora:server-theme", { detail: session.theme }),
        );
      }
    } catch {
      // Server unreachable: stay unauthenticated rather than trusting local state.
      setState("unauthenticated");
      setOwnerId(null);
      setUserLabel(null);
      paletteRef.current = ["#000000"];
      setDrawingPalette(["#000000"]);
    }
  };

  const updateDrawingPalette = async (next: DrawingPalette): Promise<void> => {
    const previous = paletteRef.current;
    const requestId = ++paletteRequestRef.current;
    paletteRef.current = next;
    setDrawingPalette(next);
    const save = paletteSaveQueueRef.current.then(() =>
      apiPatch<{ drawingPalette: DrawingPalette }>(
        "/api/account/drawing-palette",
        { drawingPalette: next },
      ),
    );
    // Keep the queue alive after a failed save so a subsequent edit can retry.
    paletteSaveQueueRef.current = save.catch(() => undefined);
    try {
      const response = await save;
      // Do not let an older request overwrite a newer local edit.
      if (requestId === paletteRequestRef.current) {
        paletteRef.current = response.drawingPalette;
        setDrawingPalette(response.drawingPalette);
      }
    } catch (cause) {
      // A newer queued edit owns the visible state and will retry with its full palette.
      if (requestId !== paletteRequestRef.current) return;
      paletteRef.current = previous;
      setDrawingPalette(previous);
      const detail = cause instanceof Error ? ` ${cause.message}` : "";
      throw new Error(
        `Could not save the drawing palette. Your change was reverted; please try again.${detail}`,
      );
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return {
    state,
    ownerId,
    userLabel,
    drawingPalette,
    updateDrawingPalette,
    refresh,
  };
}

export async function logout(): Promise<void> {
  await apiPost("/api/auth/logout", {});
}
