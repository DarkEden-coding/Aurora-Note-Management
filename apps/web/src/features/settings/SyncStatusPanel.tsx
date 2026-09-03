// This module is Aurora's sync status drawer: it reports the WebSocket state, pending outbox depth, unresolved conflicts, and last sync time via the shared sync engine store.
import { useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { syncEngine } from "../../sync/engine.js";

function formatTime(ms: number | null): string {
  if (ms === null) return "never";
  return new Date(ms).toLocaleTimeString();
}

export function SyncStatusPanel({ onClose }: { onClose: () => void }) {
  const status = useSyncExternalStore(
    syncEngine.subscribe,
    syncEngine.getStatus,
  );

  return (
    <div
      className="drawer panel"
      role="dialog"
      aria-modal="true"
      aria-label="Sync status"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="drawer-header">
        <div>
          <span className="eyebrow">Connection</span>
          <h2>Sync status</h2>
        </div>
        <button
          className="icon-button ghost"
          onClick={onClose}
          aria-label="Close sync status"
        >
          <X size={17} />
        </button>
      </div>
      <dl className="kv">
        <dt>Connection</dt>
        <dd>{status.state}</dd>
        <dt>Network</dt>
        <dd>{status.online ? "online" : "offline"}</dd>
        <dt>Pending operations</dt>
        <dd>{status.pendingOperations}</dd>
        <dt>Unresolved conflicts</dt>
        <dd>{status.conflicts}</dd>
        <dt>Last sync</dt>
        <dd>{formatTime(status.lastSyncAt)}</dd>
      </dl>
      <p className="description" style={{ margin: 0 }}>
        Edits persist to this device first and leave the outbox only after the
        server acknowledges the resulting revision. Conflicts appear as a dialog
        with both complete versions.
      </p>
    </div>
  );
}
