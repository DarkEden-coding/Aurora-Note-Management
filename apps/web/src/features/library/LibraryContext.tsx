// This module is the library state container: it loads the project/folder/note tree, applies optimistic local updates through the IndexedDB cache, mirrors mutations to the server, and tracks recents, favorites, and the search query for the sidebar.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { db } from "../../sync/db.js";
import type { CachedNote } from "../../sync/db.js";
import * as libraryApi from "./api.js";
import type { LibraryTree } from "./types.js";

export interface LibraryState {
  loaded: boolean;
  projects: LibraryTree["projects"];
  folders: LibraryTree["folders"];
  notes: CachedNote[];
  search: string;
  setSearch: (query: string) => void;
  recents: string[];
  selectedNoteId: string | null;
  selectNote: (noteId: string) => void;
  refresh: () => Promise<void>;
  addProject: (name: string) => Promise<void>;
  renameProject: (projectId: string, name: string) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  addFolder: (
    projectId: string,
    parentId: string | null,
    name: string,
  ) => Promise<void>;
  addNote: (
    projectId: string,
    folderId: string | null,
    title: string,
    options?: Pick<CachedNote, "canvasMode" | "background">,
  ) => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  toggleFavorite: (noteId: string) => Promise<void>;
  trashNote: (noteId: string) => Promise<void>;
  restoreNote: (noteId: string) => Promise<void>;
  renameNote: (noteId: string, title: string) => Promise<void>;
}

const LibraryContext = createContext<LibraryState | null>(null);

function toCachedNote(note: LibraryTree["notes"][number]): CachedNote {
  return {
    id: note.id,
    projectId: note.projectId,
    folderId: note.folderId,
    title: note.title,
    kind: note.kind,
    canvasMode: note.canvasMode,
    background: note.background,
    favorite: note.favorite,
    trashed: note.trashed,
    archived: note.archived,
    updatedAt: note.updatedAt,
    lastOpenedAt: null,
    revision: note.revision,
  };
}

const RECENTS_KEY = "aurora.recents";

function readRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(RECENTS_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<LibraryTree["projects"]>([]);
  const [folders, setFolders] = useState<LibraryTree["folders"]>([]);
  const [notes, setNotes] = useState<CachedNote[]>([]);
  const [search, setSearch] = useState("");
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const tree = await libraryApi.fetchLibrary();
    setProjects(tree.projects);
    setFolders(tree.folders);
    // Merge into the cache so offline reads still have library rows.
    await db.notes.bulkPut(tree.notes.map(toCachedNote));
    const cached = await db.notes.toArray();
    setNotes(cached.filter((note) => !note.trashed));
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh().catch(() => {
      // Offline first run: fall back to whatever the local cache holds.
      void db.notes.toArray().then((cached) => {
        setProjects((current) => current);
        setNotes(cached.filter((note) => !note.trashed));
        setLoaded(true);
      });
    });
  }, [refresh]);

  const selectNote = useCallback((noteId: string) => {
    setSelectedNoteId(noteId);
    const now = Date.now();
    setRecents((current) => {
      const next = [noteId, ...current.filter((id) => id !== noteId)].slice(
        0,
        10,
      );
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      return next;
    });
    void db.notes.update(noteId, { lastOpenedAt: new Date(now).toISOString() });
  }, []);

  const patchLocal = useCallback(
    (noteId: string, patch: Partial<CachedNote>) => {
      setNotes((current) =>
        current.map((note) =>
          note.id === noteId ? { ...note, ...patch } : note,
        ),
      );
      void db.notes.update(noteId, patch);
    },
    [],
  );

  const addProject = useCallback(async (name: string) => {
    const project = await libraryApi.createProject(name);
    setProjects((current) => [...current, project]);
  }, []);

  const renameProject = useCallback(async (projectId: string, name: string) => {
    const project = await libraryApi.updateProject(projectId, { name });
    setProjects((current) =>
      current.map((item) => (item.id === projectId ? project : item)),
    );
  }, []);

  const deleteProject = useCallback(
    async (projectId: string) => {
      await libraryApi.deleteProject(projectId);
      const deletedNoteIds = notes
        .filter((note) => note.projectId === projectId)
        .map((note) => note.id);
      await db.notes.bulkDelete(deletedNoteIds);
      setProjects((current) => current.filter((item) => item.id !== projectId));
      setFolders((current) =>
        current.filter((item) => item.projectId !== projectId),
      );
      setNotes((current) =>
        current.filter((note) => note.projectId !== projectId),
      );
      setSelectedNoteId((current) =>
        current && deletedNoteIds.includes(current) ? null : current,
      );
      setRecents((current) => {
        const next = current.filter((id) => !deletedNoteIds.includes(id));
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
        return next;
      });
    },
    [notes],
  );

  const addFolder = useCallback(
    async (projectId: string, parentId: string | null, name: string) => {
      const folder = await libraryApi.createFolder(projectId, parentId, name);
      setFolders((current) => [...current, folder]);
    },
    [],
  );

  const renameFolder = useCallback(async (folderId: string, name: string) => {
    const folder = await libraryApi.updateFolder(folderId, { name });
    setFolders((current) =>
      current.map((item) => (item.id === folderId ? folder : item)),
    );
  }, []);

  const deleteFolder = useCallback(
    async (folderId: string) => {
      await libraryApi.deleteFolder(folderId);
      const descendants = new Set([folderId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const folder of folders)
          if (
            folder.parentId &&
            descendants.has(folder.parentId) &&
            !descendants.has(folder.id)
          ) {
            descendants.add(folder.id);
            changed = true;
          }
      }
      setFolders((current) =>
        current.filter((item) => !descendants.has(item.id)),
      );
      setNotes((current) =>
        current.map((note) =>
          note.folderId && descendants.has(note.folderId)
            ? { ...note, folderId: null }
            : note,
        ),
      );
    },
    [folders],
  );

  const addNote = useCallback(
    async (
      projectId: string,
      folderId: string | null,
      title: string,
      options?: Pick<CachedNote, "canvasMode" | "background">,
    ) => {
      const note = await libraryApi.createNote(
        projectId,
        folderId,
        title,
        options,
      );
      const cached = toCachedNote(note);
      await db.notes.put(cached);
      setNotes((current) => [...current, cached]);
      selectNote(note.id);
    },
    [selectNote],
  );

  const toggleFavorite = useCallback(
    async (noteId: string) => {
      const note = notes.find((candidate) => candidate.id === noteId);
      if (!note) return;
      const favorite = !note.favorite;
      patchLocal(noteId, { favorite });
      await libraryApi.updateNote(noteId, { favorite }).catch(() => undefined);
    },
    [notes, patchLocal],
  );

  const trashNote = useCallback(
    async (noteId: string) => {
      patchLocal(noteId, { trashed: true });
      setNotes((current) => current.filter((note) => note.id !== noteId));
      await libraryApi
        .updateNote(noteId, { trashed: true })
        .catch(() => undefined);
    },
    [patchLocal],
  );

  const restoreNote = useCallback(
    async (noteId: string) => {
      patchLocal(noteId, { trashed: false });
      await libraryApi
        .updateNote(noteId, { trashed: false })
        .catch(() => undefined);
      await refresh().catch(() => undefined);
    },
    [patchLocal, refresh],
  );

  const renameNote = useCallback(
    async (noteId: string, title: string) => {
      patchLocal(noteId, { title });
      await libraryApi.updateNote(noteId, { title }).catch(() => undefined);
    },
    [patchLocal],
  );

  const value = useMemo<LibraryState>(
    () => ({
      loaded,
      projects,
      folders,
      notes,
      search,
      setSearch,
      recents,
      selectedNoteId,
      selectNote,
      refresh,
      addProject,
      renameProject,
      deleteProject,
      addFolder,
      renameFolder,
      deleteFolder,
      addNote,
      toggleFavorite,
      trashNote,
      restoreNote,
      renameNote,
    }),
    [
      loaded,
      projects,
      folders,
      notes,
      search,
      recents,
      selectedNoteId,
      selectNote,
      refresh,
      addProject,
      renameProject,
      deleteProject,
      addFolder,
      renameFolder,
      deleteFolder,
      addNote,
      toggleFavorite,
      trashNote,
      restoreNote,
      renameNote,
    ],
  );

  return (
    <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>
  );
}

export function useLibrary(): LibraryState {
  const context = useContext(LibraryContext);
  if (!context)
    throw new Error("useLibrary must be used inside LibraryProvider");
  return context;
}
