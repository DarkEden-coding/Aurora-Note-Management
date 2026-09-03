// This module renders Aurora's collapsible sidebar: projects with arbitrarily nested folders, their notes, recents and favorites sections, client-side search filtering, and quick create/trash actions. It only composes library state; the canvas owns everything inside a note.
import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Heart,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import type { LibraryFolder, LibraryProject } from "./types.js";
import { useLibrary } from "./LibraryContext.js";
import type { CachedNote } from "../../sync/db.js";

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar({ collapsed, onToggleCollapsed }: SidebarProps) {
  const library = useLibrary();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );

  const query = library.search.trim().toLowerCase();

  const matches = useMemo(
    () =>
      query.length === 0
        ? null
        : new Set(
            library.notes
              .filter((note) => note.title.toLowerCase().includes(query))
              .map((note) => note.id),
          ),
    [library.notes, query],
  );

  const toggleSet = (
    set: Set<string>,
    id: string,
    apply: (next: Set<string>) => void,
  ) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  };

  const visibleFolders = (
    folders: LibraryFolder[],
    projectId: string,
    parentId: string | null,
  ): LibraryFolder[] =>
    folders.filter(
      (folder) =>
        folder.projectId === projectId && folder.parentId === parentId,
    );

  const renderNote = (note: CachedNote) => (
    <div
      key={note.id}
      className={`tree-item${library.selectedNoteId === note.id ? " selected" : ""}`}
    >
      <button
        className="tree-row tree-row-main"
        onClick={() => library.selectNote(note.id)}
        title={note.title}
      >
        <FileText size={14} className="muted" />
        <span className="label">{note.title || "Untitled"}</span>
      </button>
      <div className="tree-actions">
        <button
          className="tree-action"
          aria-label={`${note.favorite ? "Remove" : "Add"} ${note.title || "Untitled"} ${note.favorite ? "from" : "to"} favorites`}
          onClick={() => void library.toggleFavorite(note.id)}
        >
          <Star size={13} fill={note.favorite ? "currentColor" : "none"} />
        </button>
        <button
          className="tree-action danger"
          aria-label={`Move ${note.title || "Untitled"} to trash`}
          onClick={() => void library.trashNote(note.id)}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );

  const renderFolder = (
    folder: LibraryFolder,
    projectId: string,
    depth: number,
  ): React.JSX.Element => {
    const expanded = expandedFolders.has(folder.id) || matches !== null;
    const childFolders = visibleFolders(library.folders, projectId, folder.id);
    const childNotes = library.notes.filter(
      (note) =>
        note.folderId === folder.id &&
        (matches === null || matches.has(note.id)),
    );
    const empty = childFolders.length === 0 && childNotes.length === 0;
    if (matches !== null && empty) return <div key={folder.id} />;

    return (
      <div key={folder.id}>
        <div className="tree-item">
          <button
            className="tree-row tree-row-main"
            onClick={() =>
              toggleSet(expandedFolders, folder.id, setExpandedFolders)
            }
            title={folder.name}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {expanded ? (
              <FolderOpen size={14} className="muted" />
            ) : (
              <Folder size={14} className="muted" />
            )}
            <span className="label">{folder.name}</span>
          </button>
          <div className="tree-actions">
            <button
              className="tree-action"
              aria-label={`Add subfolder to ${folder.name}`}
              onClick={() =>
                void library.addFolder(projectId, folder.id, "New folder")
              }
            >
              <FolderPlus size={13} />
            </button>
            <button
              className="tree-action"
              aria-label={`Add note to ${folder.name}`}
              onClick={() =>
                void library.addNote(projectId, folder.id, "Untitled")
              }
            >
              <Plus size={13} />
            </button>
          </div>
        </div>
        {expanded ? (
          <div className="tree-children">
            {childFolders.map((child) =>
              renderFolder(child, projectId, depth + 1),
            )}
            {childNotes.map(renderNote)}
          </div>
        ) : null}
      </div>
    );
  };

  const renderProject = (project: LibraryProject): React.JSX.Element => {
    const expanded = expandedProjects.has(project.id) || matches !== null;
    const rootFolders = visibleFolders(library.folders, project.id, null);
    const rootNotes = library.notes.filter(
      (note) =>
        note.projectId === project.id &&
        note.folderId === null &&
        (matches === null || matches.has(note.id)),
    );

    return (
      <div key={project.id} className="sidebar-section">
        <div className="tree-item project-row">
          <button
            className="tree-row tree-row-main"
            onClick={() =>
              toggleSet(expandedProjects, project.id, setExpandedProjects)
            }
            title={project.name}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <FolderOpen size={14} className="muted" />
            <span className="label">
              <strong>{project.name}</strong>
            </span>
          </button>
          <div className="tree-actions">
            <button
              className="tree-action"
              aria-label={`Add folder to ${project.name}`}
              onClick={() =>
                void library.addFolder(project.id, null, "New folder")
              }
            >
              <FolderPlus size={13} />
            </button>
            <button
              className="tree-action"
              aria-label={`Add note to ${project.name}`}
              onClick={() => void library.addNote(project.id, null, "Untitled")}
            >
              <Plus size={13} />
            </button>
          </div>
        </div>
        {expanded ? (
          <div className="tree-children">
            {rootFolders.map((folder) => renderFolder(folder, project.id, 0))}
            {rootNotes.map(renderNote)}
          </div>
        ) : null}
      </div>
    );
  };

  const recentNotes = library.recents
    .map((id) => library.notes.find((note) => note.id === id))
    .filter((note): note is CachedNote => note !== undefined);
  const favoriteNotes = library.notes.filter((note) => note.favorite);

  return (
    <aside className={`sidebar panel${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-header">
        {collapsed ? null : <h1>Aurora</h1>}
        <button
          className="ghost"
          onClick={onToggleCollapsed}
          title="Toggle sidebar"
        >
          {collapsed ? (
            <PanelLeftOpen size={16} />
          ) : (
            <PanelLeftClose size={16} />
          )}
        </button>
      </div>

      {collapsed ? null : (
        <>
          <div className="field">
            <label htmlFor="library-search">Search</label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Search size={14} className="muted" />
              <input
                id="library-search"
                style={{ flex: 1 }}
                value={library.search}
                onChange={(event) => library.setSearch(event.target.value)}
                placeholder="Filter notes"
              />
            </div>
          </div>

          {recentNotes.length > 0 ? (
            <div className="sidebar-section">
              <div className="sidebar-section-title">
                <History size={11} style={{ verticalAlign: "-2px" }} /> Recent
              </div>
              {recentNotes.map(renderNote)}
            </div>
          ) : null}

          {favoriteNotes.length > 0 ? (
            <div className="sidebar-section">
              <div className="sidebar-section-title">
                <Heart size={11} style={{ verticalAlign: "-2px" }} /> Favorites
              </div>
              {favoriteNotes.map(renderNote)}
            </div>
          ) : null}

          <div className="sidebar-section">
            <div className="sidebar-section-title">Projects</div>
            {library.projects.map(renderProject)}
            {!library.loaded ? (
              <div className="tree-row muted">Loading library…</div>
            ) : null}
            {library.loaded && library.projects.length === 0 ? (
              <button
                className="tree-row"
                onClick={() => void library.addProject("My project")}
              >
                <Plus size={14} /> Create first project
              </button>
            ) : null}
            {library.loaded && library.projects.length > 0 ? (
              <button
                className="new-project-button"
                onClick={() => void library.addProject("New project")}
              >
                <Plus size={14} /> New project
              </button>
            ) : null}
          </div>

          {library.selectedNoteId ? (
            <button
              className="ghost"
              onClick={() => void library.trashNote(library.selectedNoteId!)}
            >
              <Trash2 size={14} style={{ verticalAlign: "-2px" }} /> Trash
              current note
            </button>
          ) : null}
        </>
      )}
    </aside>
  );
}
