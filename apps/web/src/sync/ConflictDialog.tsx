// This module provides Aurora's conflict presentation: it lists unresolved
// conflicts surfaced from server conflict acks and lets the user keep either
// complete version by calling the server's explicit resolution route — never
// character-level merging. The winning version is stored locally afterwards.
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { apiPost } from "../lib/http.js";
import type { CanvasObject } from "@aurora/shared";
import { db } from "./db.js";
import type { ConflictRow } from "./db.js";

interface ResolveResponse {
  resolved: boolean;
  object: CanvasObject | null;
}

async function resolveConflict(
  conflict: ConflictRow,
  choice: "local" | "server",
): Promise<void> {
  // Server contract: "incoming" re-applies the client version, "base" keeps the
  // authoritative server version.
  const resolution = choice === "local" ? "incoming" : "base";
  const result = await apiPost<ResolveResponse>(
    `/api/sync/conflicts/${conflict.id}/resolve`,
    { resolution },
  );
  if (result.object) {
    await db.objects.put(result.object);
  } else {
    await db.objects.delete(conflict.objectId);
  }
  await db.conflicts.delete(conflict.id);
}

export function ConflictDialog(): React.JSX.Element | null {
  const conflicts = useLiveQuery(
    () => db.conflicts.toArray(),
    [],
    [] as ConflictRow[],
  );
  const [busy, setBusy] = useState<string | null>(null);

  const conflict = conflicts[0];
  if (!conflict) return null;

  const resolve = async (choice: "local" | "server") => {
    setBusy(choice);
    try {
      await resolveConflict(conflict, choice);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="drawer-overlay">
      <div
        className="drawer panel"
        role="dialog"
        aria-modal="true"
        aria-label="Resolve sync conflict"
      >
        <h2>Sync conflict</h2>
        <p style={{ margin: 0, color: "var(--text-muted)" }}>
          This object changed on two devices against the same revision. Choose
          which version to keep; the other will be discarded.
        </p>
        <div className="conflict-versions">
          <div>
            <strong>
              This device
              {"deleted" in conflict.localObject
                ? " (delete)"
                : ` (revision ${conflict.localObject.revision})`}
            </strong>
            <pre>{JSON.stringify(conflict.localObject, null, 2)}</pre>
          </div>
          <div>
            <strong>
              Server
              {conflict.serverObject
                ? ` (revision ${conflict.serverObject.revision})`
                : " (object missing)"}
            </strong>
            <pre>{JSON.stringify(conflict.serverObject, null, 2)}</pre>
          </div>
        </div>
        <div className="settings-row">
          <button
            disabled={busy !== null}
            onClick={() => void resolve("local")}
          >
            Keep this device
          </button>
          <button
            className="primary"
            disabled={busy !== null}
            onClick={() => void resolve("server")}
          >
            Keep server version
          </button>
        </div>
      </div>
    </div>
  );
}
