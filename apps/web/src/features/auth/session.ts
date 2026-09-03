// This module tracks Aurora's browser session state: it asks the server on boot (the cookie is the only authority) and exposes the authenticated/unauthenticated decision plus logout to the shell.
import { useEffect, useState } from "react";
import { api, apiPost } from "../../lib/http.js";

export type SessionState = "checking" | "authenticated" | "unauthenticated";

interface SessionResponse {
  authenticated: boolean;
  ownerId: string;
  sessionId: string;
  enrolled: boolean;
  theme: "neomorphic" | "glass" | "minimal";
}

export function useSession(): {
  state: SessionState;
  ownerId: string | null;
  userLabel: string | null;
  refresh: () => Promise<void>;
} {
  const [state, setState] = useState<SessionState>("checking");
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [userLabel, setUserLabel] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const session = await api<SessionResponse>("/api/auth/session");
      setState(session.authenticated ? "authenticated" : "unauthenticated");
      setOwnerId(session.ownerId);
      setUserLabel(session.enrolled ? "Passkey owner" : null);
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
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return { state, ownerId, userLabel, refresh };
}

export async function logout(): Promise<void> {
  await apiPost("/api/auth/logout", {});
}
