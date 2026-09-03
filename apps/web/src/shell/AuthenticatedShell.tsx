// This module composes Aurora's authenticated shell: sidebar, topbar with sync indicator, the main editor, and the settings/sync/conflict drawers. It holds composition only and owns no feature logic.
import { useEffect, useState } from "react";
import { Settings, Wifi, WifiOff } from "lucide-react";
import { Sidebar } from "../features/library/LibrarySidebar.js";
import { useLibrary } from "../features/library/LibraryContext.js";
import { AccountSettings } from "../features/settings/AccountSettings.js";
import { SyncStatusPanel } from "../features/settings/SyncStatusPanel.js";
import { ConflictDialog } from "../sync/ConflictDialog.js";
import { syncEngine, type SyncStatus } from "../sync/engine.js";
import { useSyncExternalStore } from "react";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { MainEditor } from "./MainEditor.js";

type DrawerKind = "none" | "settings" | "sync";

function NoteTitle({ noteId, title }: { noteId: string; title: string }) {
  const library = useLibrary();
  const [draft, setDraft] = useState(title);

  useEffect(() => setDraft(title), [noteId, title]);

  const commit = () => {
    const next = draft.trim() || "Untitled";
    setDraft(next);
    if (next !== title) void library.renameNote(noteId, next);
  };

  return (
    <input
      className="note-title-input"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(title);
          event.currentTarget.blur();
        }
      }}
      aria-label="Note title"
      maxLength={200}
    />
  );
}

function SyncPill({ onClick }: { onClick: () => void }) {
  const status: SyncStatus = useSyncExternalStore(
    syncEngine.subscribe,
    syncEngine.getStatus,
  );
  const dotClass = !status.online
    ? "offline"
    : status.state === "open" && status.pendingOperations === 0
      ? "online"
      : "syncing";
  return (
    <button className="sync-pill" onClick={onClick} title="Sync status">
      {status.online ? <Wifi size={13} /> : <WifiOff size={13} />}
      <span className={`sync-dot ${dotClass}`} />
      {status.pendingOperations > 0
        ? `${status.pendingOperations} queued`
        : status.state}
    </button>
  );
}

export function AuthenticatedShell({
  ownerId,
  userLabel,
  onLoggedOut,
}: {
  ownerId: string;
  userLabel: string | null;
  onLoggedOut: () => void;
}) {
  const library = useLibrary();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState<DrawerKind>("none");

  // Start the sync engine (WebSocket subscription + outbox loop) once authenticated.
  useEffect(() => {
    syncEngine.start();
    return () => syncEngine.stop();
  }, []);

  useEffect(() => {
    if (drawer === "none") return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawer("none");
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [drawer]);

  const selectedNote =
    library.notes.find((note) => note.id === library.selectedNoteId) ?? null;

  return (
    <div className="app-shell">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
      />

      <div className="main-column">
        <div className="topbar">
          <div className="title">
            {selectedNote ? (
              <NoteTitle
                noteId={selectedNote.id}
                title={selectedNote.title || "Untitled"}
              />
            ) : (
              <span>No note selected</span>
            )}
          </div>
          <SyncPill onClick={() => setDrawer("sync")} />
          <button
            className="ghost"
            onClick={() => setDrawer("settings")}
            title="Account settings"
          >
            <Settings size={16} />
          </button>
        </div>

        <ErrorBoundary label="editor">
          {selectedNote ? (
            <MainEditor
              ownerId={ownerId}
              noteId={selectedNote.id}
              canvasMode={selectedNote.canvasMode}
              background={selectedNote.background}
            />
          ) : (
            <div className="canvas-area">
              <div className="canvas-empty">
                Select or create a note in the sidebar.
              </div>
            </div>
          )}
        </ErrorBoundary>
      </div>

      {drawer === "settings" ? (
        <div className="drawer-overlay" onClick={() => setDrawer("none")}>
          <AccountSettings
            userLabel={userLabel}
            onLoggedOut={onLoggedOut}
            onClose={() => setDrawer("none")}
          />
        </div>
      ) : null}

      {drawer === "sync" ? (
        <div className="drawer-overlay" onClick={() => setDrawer("none")}>
          <SyncStatusPanel onClose={() => setDrawer("none")} />
        </div>
      ) : null}

      <ConflictDialog />
    </div>
  );
}
