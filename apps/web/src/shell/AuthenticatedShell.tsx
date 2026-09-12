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
import { ChatView } from "../features/chat/ChatView.js";
import * as chatApi from "../features/chat/api.js";
import "../features/chat/chatStyles.css";
import {
  CHAT_MODELS,
  type CanvasMode,
  type ChatConversation,
  type ChatModel,
  type ChatReasoning,
  type DrawingPalette,
} from "@aurora/shared";

type DrawerKind = "none" | "settings" | "sync";

function NoteTitle({ noteId, title }: { noteId: string; title: string }) {
  const library = useLibrary();
  const [draft, setDraft] = useState(title);

  useEffect(() => setDraft(title), [noteId, title]);

  const commit = () => {
    const next = draft.trim() || "Untitled";
    setDraft(next);
    if (next !== title) {
      void library.renameNote(noteId, next).catch(() => undefined);
    }
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

/** Human-readable canvas extent shown beside connectivity state. */
function canvasModeLabel(mode: CanvasMode): string {
  switch (mode) {
    case "fixed-width":
      return "Fixed width";
    case "fixed-height":
      return "Fixed height";
    case "paged":
      return "Paged";
    case "infinite":
      return "Infinite";
  }
}

/** Per-conversation model controls shown in the chat top bar. */
function ChatControls({
  conversation,
  onChange,
}: {
  conversation: ChatConversation;
  onChange: (patch: {
    model?: ChatModel;
    reasoning?: ChatReasoning;
  }) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const selectedModel =
    CHAT_MODELS.find((model) => model.id === conversation.model) ??
    CHAT_MODELS[1];
  const change = async (patch: {
    model?: ChatModel;
    reasoning?: ChatReasoning;
  }): Promise<void> => {
    setSaving(true);
    setSaveError(false);
    try {
      await onChange(patch);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="chat-topbar-controls">
      <select
        aria-label="Chat model"
        value={conversation.model}
        disabled={saving}
        onChange={(event) =>
          void change({ model: event.target.value as ChatModel })
        }
      >
        {CHAT_MODELS.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Reasoning level"
        value={conversation.reasoning}
        disabled={saving}
        onChange={(event) =>
          void change({ reasoning: event.target.value as ChatReasoning })
        }
      >
        {selectedModel.reasoningLevels.map((level) => (
          <option key={level} value={level}>
            {level === "xhigh"
              ? "XHigh"
              : `${level[0]!.toUpperCase()}${level.slice(1)}`}
          </option>
        ))}
      </select>
      {saveError ? (
        <span className="error-text" role="alert">
          Settings not saved
        </span>
      ) : null}
    </div>
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
    <button
      className="sync-pill"
      onClick={onClick}
      title="Sync status"
      aria-label="Open sync status"
    >
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
  drawingPalette,
  onDrawingPaletteChange,
  onLoggedOut,
}: {
  ownerId: string;
  userLabel: string | null;
  drawingPalette: DrawingPalette;
  onDrawingPaletteChange: (drawingPalette: DrawingPalette) => Promise<void>;
  onLoggedOut: () => void;
}) {
  const library = useLibrary();
  const [collapsed, setCollapsed] = useState(
    () => window.matchMedia("(max-width: 760px)").matches,
  );
  const [drawer, setDrawer] = useState<DrawerKind>("none");
  const [view, setView] = useState<"notes" | "chat">("notes");
  const [conversation, setConversation] = useState<ChatConversation | null>(
    null,
  );

  // Start the sync engine (WebSocket subscription + outbox loop) once authenticated.
  useEffect(() => {
    syncEngine.start();
    return () => syncEngine.stop();
  }, []);

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 760px)");
    const collapseOnMobile = (event: MediaQueryListEvent) => {
      if (event.matches) setCollapsed(true);
    };
    mobile.addEventListener("change", collapseOnMobile);
    return () => mobile.removeEventListener("change", collapseOnMobile);
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

  /** Persists model controls on the selected conversation. */
  const updateConversationSettings = async (patch: {
    model?: ChatModel;
    reasoning?: ChatReasoning;
  }): Promise<void> => {
    if (!conversation) return;
    const updated = await chatApi.updateConversation(conversation.id, patch);
    setConversation(updated);
  };

  return (
    <div className="app-shell">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        view={view}
        onViewChange={setView}
        selectedConversation={conversation}
        onSelectConversation={(selected) => {
          setConversation(selected);
          if (window.matchMedia("(max-width: 760px)").matches) {
            setCollapsed(true);
          }
        }}
      />

      <div className="main-column">
        <div className="topbar">
          <div className="title">
            {view === "chat" ? (
              <span>{conversation?.title ?? "No chat selected"}</span>
            ) : selectedNote ? (
              <NoteTitle
                noteId={selectedNote.id}
                title={selectedNote.title || "Untitled"}
              />
            ) : (
              <span>No note selected</span>
            )}
          </div>
          <div className="connection-status">
            {view === "chat" && conversation ? (
              <ChatControls
                conversation={conversation}
                onChange={updateConversationSettings}
              />
            ) : null}
            <SyncPill onClick={() => setDrawer("sync")} />
            {view === "notes" && selectedNote ? (
              <span className="canvas-mode-indicator">
                {canvasModeLabel(selectedNote.canvasMode)}
              </span>
            ) : null}
          </div>
          <button
            className="ghost"
            onClick={() => setDrawer("settings")}
            title="Account settings"
            aria-label="Open account settings"
          >
            <Settings size={16} />
          </button>
        </div>

        <ErrorBoundary label="editor">
          {view === "chat" ? (
            <ChatView
              conversation={conversation}
              onConversationUpdated={setConversation}
            />
          ) : selectedNote ? (
            <MainEditor
              ownerId={ownerId}
              noteId={selectedNote.id}
              canvasMode={selectedNote.canvasMode}
              background={selectedNote.background}
              drawingPalette={drawingPalette}
              onDrawingPaletteChange={onDrawingPaletteChange}
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
