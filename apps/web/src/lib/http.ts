// This module is the single HTTP client for Aurora's browser: every private request relies on the server's session cookie, and failed private responses surface as errors the shell routes to login.
// Server route families (all session-authenticated): /api/auth/*, /api/library,
// /api/projects, /api/folders, /api/notes, /api/notes/:id/objects/query,
// /api/sync/operations, /api/sync/conflicts, /api/files, /api/search,
// /api/backup, /api/snapshots. The WebSocket endpoint is /sync/ws.
// Payload schemas come from @aurora/shared.
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      ...(init?.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...init?.headers,
    },
    ...init,
  });
  if (!response.ok) {
    throw new ApiError(
      response.status,
      `${init?.method ?? "GET"} ${path} failed: ${response.status}`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}
