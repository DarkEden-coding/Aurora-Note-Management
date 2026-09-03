// Aurora's library tree, creation dialogs, and pointer-positioned context menus.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Heart,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import type { Background, CanvasMode } from "@aurora/shared";
import type { CachedNote } from "../../sync/db.js";
import type { LibraryFolder, LibraryProject } from "./types.js";
import { useLibrary } from "./LibraryContext.js";

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}
type DialogState =
  | { kind: "project" }
  | { kind: "note"; projectId: string; folderId: string | null }
  | {
      kind:
        | "rename-project"
        | "rename-folder"
        | "rename-note"
        | "confirm-project"
        | "confirm-folder";
      id: string;
      value: string;
    };
type MenuTarget =
  | { kind: "project"; item: LibraryProject }
  | { kind: "folder"; item: LibraryFolder }
  | { kind: "note"; item: CachedNote };
interface MenuState {
  x: number;
  y: number;
  target: MenuTarget;
}
const NOTE_COLORS = ["#171a21", "#111827", "#18152a", "#17211d", "#21191b"];
const PATTERNS: { value: Background["pattern"]; label: string }[] = [
  { value: "dot-grid", label: "Dots" },
  { value: "square-grid", label: "Grid" },
  { value: "ruled", label: "Ruled" },
  { value: "blank", label: "Blank" },
];
const MODES: { value: CanvasMode; label: string }[] = [
  { value: "infinite", label: "Infinite" },
  { value: "fixed-width", label: "Fixed width" },
  { value: "fixed-height", label: "Fixed height" },
  { value: "paged", label: "Pages" },
];

export function Sidebar({ collapsed, onToggleCollapsed }: SidebarProps) {
  const library = useLibrary();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const query = library.search.trim().toLowerCase();
  const matches = useMemo(
    () =>
      query
        ? new Set(
            library.notes
              .filter((n) => n.title.toLowerCase().includes(query))
              .map((n) => n.id),
          )
        : null,
    [library.notes, query],
  );
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  const toggle = (
    set: Set<string>,
    id: string,
    apply: (value: Set<string>) => void,
  ) => {
    const next = new Set(set);
    next.has(id) ? next.delete(id) : next.add(id);
    apply(next);
  };
  const openMenu = (event: React.MouseEvent, target: MenuTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 190),
      target,
    });
  };
  const visibleFolders = (projectId: string, parentId: string | null) =>
    library.folders.filter(
      (f) => f.projectId === projectId && f.parentId === parentId,
    );
  const renderNote = (note: CachedNote) => (
    <div
      key={note.id}
      className={`tree-item${library.selectedNoteId === note.id ? " selected" : ""}`}
      onContextMenu={(event) => openMenu(event, { kind: "note", item: note })}
    >
      <button
        className="tree-row tree-row-main"
        onClick={() => library.selectNote(note.id)}
        title={note.title}
      >
        <FileText size={16} className="muted" />
        <span className="label">{note.title || "Untitled"}</span>
        {note.favorite ? (
          <Star size={13} fill="currentColor" className="favorite-mark" />
        ) : null}
      </button>
    </div>
  );
  const renderFolder = (
    folder: LibraryFolder,
    projectId: string,
  ): React.JSX.Element => {
    const expanded = expandedFolders.has(folder.id) || matches !== null;
    const childFolders = visibleFolders(projectId, folder.id);
    const childNotes = library.notes.filter(
      (n) =>
        n.folderId === folder.id && (matches === null || matches.has(n.id)),
    );
    if (
      matches !== null &&
      childFolders.length === 0 &&
      childNotes.length === 0
    )
      return <div key={folder.id} />;
    return (
      <div key={folder.id}>
        <div
          className="tree-item"
          onContextMenu={(event) =>
            openMenu(event, { kind: "folder", item: folder })
          }
        >
          <button
            className="tree-row tree-row-main"
            onClick={() =>
              toggle(expandedFolders, folder.id, setExpandedFolders)
            }
            title={folder.name}
          >
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            {expanded ? (
              <FolderOpen size={16} className="muted" />
            ) : (
              <Folder size={16} className="muted" />
            )}
            <span className="label">{folder.name}</span>
          </button>
          <button
            className="tree-action"
            aria-label={`Add note to ${folder.name}`}
            onClick={() =>
              setDialog({ kind: "note", projectId, folderId: folder.id })
            }
          >
            <Plus size={15} />
          </button>
        </div>
        {expanded ? (
          <div className="tree-children">
            {childFolders.map((child) => renderFolder(child, projectId))}
            {childNotes.map(renderNote)}
          </div>
        ) : null}
      </div>
    );
  };
  const renderProject = (project: LibraryProject) => {
    const expanded = expandedProjects.has(project.id) || matches !== null;
    const rootNotes = library.notes.filter(
      (n) =>
        n.projectId === project.id &&
        n.folderId === null &&
        (matches === null || matches.has(n.id)),
    );
    return (
      <div key={project.id} className="sidebar-section">
        <div
          className="tree-item project-row"
          onContextMenu={(event) =>
            openMenu(event, { kind: "project", item: project })
          }
        >
          <button
            className="tree-row tree-row-main"
            onClick={() =>
              toggle(expandedProjects, project.id, setExpandedProjects)
            }
            title={project.name}
          >
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <FolderOpen size={16} className="muted" />
            <span className="label">
              <strong>{project.name}</strong>
            </span>
          </button>
          <button
            className="tree-action"
            aria-label={`Add folder to ${project.name}`}
            onClick={() =>
              void library.addFolder(project.id, null, "New folder")
            }
          >
            <FolderPlus size={15} />
          </button>
          <button
            className="tree-action"
            aria-label={`Add note to ${project.name}`}
            onClick={() =>
              setDialog({ kind: "note", projectId: project.id, folderId: null })
            }
          >
            <Plus size={15} />
          </button>
        </div>
        {expanded ? (
          <div className="tree-children">
            {visibleFolders(project.id, null).map((folder) =>
              renderFolder(folder, project.id),
            )}
            {rootNotes.map(renderNote)}
          </div>
        ) : null}
      </div>
    );
  };
  const contextAction = (action: string) => {
    if (!menu) return;
    const { target } = menu;
    setMenu(null);
    if (target.kind === "project") {
      if (action === "rename")
        setDialog({
          kind: "rename-project",
          id: target.item.id,
          value: target.item.name,
        });
      if (action === "folder")
        void library.addFolder(target.item.id, null, "New folder");
      if (action === "note")
        setDialog({ kind: "note", projectId: target.item.id, folderId: null });
      if (action === "delete")
        setDialog({
          kind: "confirm-project",
          id: target.item.id,
          value: target.item.name,
        });
    } else if (target.kind === "folder") {
      if (action === "rename")
        setDialog({
          kind: "rename-folder",
          id: target.item.id,
          value: target.item.name,
        });
      if (action === "folder")
        void library.addFolder(
          target.item.projectId,
          target.item.id,
          "New folder",
        );
      if (action === "note")
        setDialog({
          kind: "note",
          projectId: target.item.projectId,
          folderId: target.item.id,
        });
      if (action === "delete")
        setDialog({
          kind: "confirm-folder",
          id: target.item.id,
          value: target.item.name,
        });
    } else {
      if (action === "rename")
        setDialog({
          kind: "rename-note",
          id: target.item.id,
          value: target.item.title,
        });
      if (action === "favorite") void library.toggleFavorite(target.item.id);
      if (action === "delete") void library.trashNote(target.item.id);
    }
  };
  return (
    <>
      <aside className={`sidebar panel${collapsed ? " collapsed" : ""}`}>
        <div className="sidebar-header">
          {collapsed ? null : <h1>Aurora</h1>}
          <button
            className="ghost icon-button"
            onClick={onToggleCollapsed}
            title="Toggle sidebar"
          >
            {collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <PanelLeftClose size={18} />
            )}
          </button>
        </div>
        {collapsed ? null : (
          <>
            <div className="field library-search">
              <label htmlFor="library-search">Search</label>
              <div>
                <Search size={15} className="muted" />
                <input
                  id="library-search"
                  value={library.search}
                  onChange={(event) => library.setSearch(event.target.value)}
                  placeholder="Filter notes"
                />
              </div>
            </div>
            {library.notes.some((note) => note.favorite) ? (
              <div className="sidebar-section">
                <div className="sidebar-section-title">
                  <Heart size={12} /> Favorites
                </div>
                {library.notes.filter((note) => note.favorite).map(renderNote)}
              </div>
            ) : null}
            <div className="sidebar-section">
              <div className="sidebar-section-title">Projects</div>
              {library.projects.map(renderProject)}
              {!library.loaded ? (
                <div className="tree-row muted">Loading library…</div>
              ) : null}
              <button
                className="new-project-button"
                onClick={() => setDialog({ kind: "project" })}
              >
                <Plus size={16} />{" "}
                {library.projects.length
                  ? "New project"
                  : "Create first project"}
              </button>
            </div>
          </>
        )}
      </aside>
      {menu ? <ContextMenu menu={menu} onAction={contextAction} /> : null}
      {dialog ? (
        <LibraryDialog state={dialog} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}

function ContextMenu({
  menu,
  onAction,
}: {
  menu: MenuState;
  onAction: (action: string) => void;
}) {
  const isContainer = menu.target.kind !== "note";
  return (
    <div
      className="context-menu panel"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button role="menuitem" onClick={() => onAction("rename")}>
        Rename
      </button>
      {isContainer ? (
        <button role="menuitem" onClick={() => onAction("note")}>
          <Plus size={14} /> New note
        </button>
      ) : null}
      {isContainer ? (
        <button role="menuitem" onClick={() => onAction("folder")}>
          <FolderPlus size={14} /> New folder
        </button>
      ) : null}
      {menu.target.kind === "note" ? (
        <button role="menuitem" onClick={() => onAction("favorite")}>
          <Star size={14} />{" "}
          {menu.target.item.favorite ? "Remove favorite" : "Add favorite"}
        </button>
      ) : null}
      <div className="context-divider" />
      <button
        role="menuitem"
        className="danger"
        onClick={() => onAction("delete")}
      >
        <Trash2 size={14} />{" "}
        {menu.target.kind === "note" ? "Move to trash" : "Delete"}
      </button>
    </div>
  );
}

function LibraryDialog({
  state,
  onClose,
}: {
  state: DialogState;
  onClose: () => void;
}) {
  const library = useLibrary();
  const initial =
    "value" in state ? state.value : state.kind === "project" ? "" : "Untitled";
  const [name, setName] = useState(initial);
  const [mode, setMode] = useState<CanvasMode>("infinite");
  const [pattern, setPattern] = useState<Background["pattern"]>("dot-grid");
  const [color, setColor] = useState(NOTE_COLORS[0]!);
  const [error, setError] = useState("");
  const destructive = state.kind.startsWith("confirm-");
  const note = state.kind === "note";
  const title =
    state.kind === "project"
      ? "Create project"
      : note
        ? "Create note"
        : destructive
          ? `Delete ${state.kind === "confirm-project" ? "project" : "folder"}?`
          : `Rename ${state.kind.replace("rename-", "")}`;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      if (state.kind === "project") await library.addProject(name.trim());
      else if (state.kind === "note")
        await library.addNote(
          state.projectId,
          state.folderId,
          name.trim() || "Untitled",
          {
            canvasMode: mode,
            background: {
              pattern,
              color,
              patternColor: "#354052",
              spacing: 24,
            },
          },
        );
      else if (state.kind === "rename-project")
        await library.renameProject(state.id, name.trim());
      else if (state.kind === "rename-folder")
        await library.renameFolder(state.id, name.trim());
      else if (state.kind === "rename-note")
        await library.renameNote(state.id, name.trim() || "Untitled");
      else if (state.kind === "confirm-project")
        await library.deleteProject(state.id);
      else await library.deleteFolder(state.id);
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not complete that action",
      );
    }
  };
  return (
    <div
      className="drawer-overlay library-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="library-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="library-dialog-title"
        onSubmit={(event) => void submit(event)}
      >
        <div className="drawer-header">
          <div>
            <span className="eyebrow">Library</span>
            <h2 id="library-dialog-title">{title}</h2>
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
        {destructive ? (
          <p className="dialog-copy">
            Delete{" "}
            <strong>{"value" in state ? state.value : "this item"}</strong>?{" "}
            {state.kind === "confirm-project"
              ? "Projects containing notes cannot be deleted."
              : "Notes inside this folder will move to the project root."}
          </p>
        ) : (
          <div className="field">
            <label htmlFor="library-name">Name</label>
            <input
              id="library-name"
              autoFocus
              required={state.kind !== "note"}
              maxLength={state.kind === "note" ? 200 : 120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        )}
        {note ? (
          <>
            <fieldset className="choice-field">
              <legend>Canvas style</legend>
              <div className="segmented-options">
                {MODES.map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    data-selected={mode === item.value}
                    onClick={() => setMode(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="choice-field">
              <legend>Background style</legend>
              <div className="segmented-options">
                {PATTERNS.map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    data-selected={pattern === item.value}
                    onClick={() => setPattern(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </fieldset>
            <fieldset className="choice-field">
              <legend>Canvas color</legend>
              <div className="color-options">
                {NOTE_COLORS.map((item) => (
                  <button
                    type="button"
                    key={item}
                    aria-label={`Canvas color ${item}`}
                    data-selected={color === item}
                    style={{ background: item }}
                    onClick={() => setColor(item)}
                  />
                ))}
              </div>
            </fieldset>
            <div
              className="canvas-choice-preview"
              style={getPreviewStyle(color, pattern)}
            />
          </>
        ) : null}
        {error ? <div className="error-text">{error}</div> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={destructive ? "danger-button" : "primary"}
          >
            {destructive
              ? "Delete"
              : state.kind.startsWith("rename-")
                ? "Save"
                : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

function getPreviewStyle(
  color: string,
  pattern: Background["pattern"],
): React.CSSProperties {
  const ink = "#354052";
  if (pattern === "dot-grid")
    return {
      backgroundColor: color,
      backgroundImage: `radial-gradient(circle, ${ink} 1px, transparent 1.5px)`,
      backgroundSize: "18px 18px",
    };
  if (pattern === "square-grid")
    return {
      backgroundColor: color,
      backgroundImage: `linear-gradient(${ink} 1px, transparent 1px), linear-gradient(90deg, ${ink} 1px, transparent 1px)`,
      backgroundSize: "18px 18px",
    };
  if (pattern === "ruled")
    return {
      backgroundColor: color,
      backgroundImage: `linear-gradient(${ink} 1px, transparent 1px)`,
      backgroundSize: "18px 18px",
    };
  return { backgroundColor: color };
}
