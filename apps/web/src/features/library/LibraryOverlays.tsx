// Search and trash dialogs opened from the sidebar header.
import { useEffect, useState, type ReactNode } from "react";
import { FileText, RotateCcw, Search, Trash2 } from "lucide-react";
import type { CachedNote } from "../../sync/db.js";
import { useLibrary } from "./LibraryContext.js";

function Overlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  return (
    <div
      className="drawer-overlay library-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="library-dialog library-overlay panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="drawer-header">
          <div>
            <span className="eyebrow">Library</span>
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function useNotePath(): (note: CachedNote) => string {
  const { projects, folders } = useLibrary();
  return (note) =>
    [
      projects.find((p) => p.id === note.projectId)?.name,
      folders.find((f) => f.id === note.folderId)?.name,
    ]
      .filter(Boolean)
      .join(" / ");
}

export function SearchDialog({
  onOpen,
  onClose,
}: {
  onOpen: (noteId: string) => void;
  onClose: () => void;
}) {
  const library = useLibrary();
  const pathOf = useNotePath();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const needle = query.trim().toLowerCase();
  const results = library.notes.filter((note) =>
    (note.title || "Untitled").toLowerCase().includes(needle),
  );
  const highlighted = Math.min(active, results.length - 1);
  return (
    <Overlay title="Search notes" onClose={onClose}>
      <div className="library-search">
        <div>
          <Search size={15} className="muted" />
          <input
            autoFocus
            value={query}
            placeholder="Note title"
            aria-label="Note title"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown")
                setActive(Math.min(highlighted + 1, results.length - 1));
              else if (event.key === "ArrowUp")
                setActive(Math.max(highlighted - 1, 0));
              else if (event.key === "Enter" && results[highlighted])
                onOpen(results[highlighted].id);
              else return;
              event.preventDefault();
            }}
          />
        </div>
      </div>
      <div className="overlay-list">
        {results.map((note, index) => (
          <div
            key={note.id}
            className={`tree-item${index === highlighted ? " selected" : ""}`}
          >
            <button
              className="tree-row tree-row-main"
              onClick={() => onOpen(note.id)}
              onMouseEnter={() => setActive(index)}
            >
              <FileText size={16} className="muted" />
              <span className="label">{note.title || "Untitled"}</span>
              <span className="overlay-path">{pathOf(note)}</span>
            </button>
          </div>
        ))}
        {results.length === 0 ? (
          <div className="tree-row muted">No notes match</div>
        ) : null}
      </div>
    </Overlay>
  );
}

export function TrashDialog({
  onDeleteForever,
  onClose,
}: {
  onDeleteForever: (note: CachedNote) => void;
  onClose: () => void;
}) {
  const library = useLibrary();
  const pathOf = useNotePath();
  return (
    <Overlay title="Trash" onClose={onClose}>
      <div className="overlay-list">
        {library.trashedNotes.map((note) => (
          <div className="tree-item" key={note.id}>
            <div className="tree-row tree-row-main" title={note.title}>
              <FileText size={16} className="muted" />
              <span className="label">{note.title || "Untitled"}</span>
              <span className="overlay-path">{pathOf(note)}</span>
            </div>
            <button
              type="button"
              className="tree-action"
              title="Restore"
              aria-label={`Restore ${note.title || "Untitled"}`}
              onClick={() =>
                void library.restoreNote(note.id).catch(() => undefined)
              }
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              className="tree-action danger"
              title="Delete permanently"
              aria-label={`Delete ${note.title || "Untitled"} permanently`}
              onClick={() => onDeleteForever(note)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {library.trashedNotes.length === 0 ? (
          <div className="tree-row muted">Trash is empty</div>
        ) : null}
      </div>
    </Overlay>
  );
}
