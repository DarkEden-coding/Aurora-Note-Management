// This module owns the online/offline library tree and recoverable metadata mutations.
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
import type { NotePatch } from "./api.js";
import { partitionCachedNotes, toCachedNote } from "./libraryCache.js";
import type { LibraryTree } from "./types.js";

export interface LibraryState {
  loaded: boolean;
  projects: LibraryTree["projects"];
  folders: LibraryTree["folders"];
  notes: CachedNote[];
  trashedNotes: CachedNote[];
  search: string;
  setSearch: (query: string) => void;
  recents: string[];
  selectedNoteId: string | null;
  selectNote: (noteId: string) => void;
  mutationError: string | null;
  clearMutationError: () => void;
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
  deleteNoteForever: (noteId: string) => Promise<void>;
  renameNote: (noteId: string, title: string) => Promise<void>;
}

const LibraryContext = createContext<LibraryState | null>(null);
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

function failure(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<LibraryTree["projects"]>([]);
  const [folders, setFolders] = useState<LibraryTree["folders"]>([]);
  const [notes, setNotes] = useState<CachedNote[]>([]);
  const [trashedNotes, setTrashedNotes] = useState<CachedNote[]>([]);
  const [search, setSearch] = useState("");
  const [recents, setRecents] = useState<string[]>(readRecents);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const showCachedNotes = useCallback((cached: readonly CachedNote[]) => {
    const partitioned = partitionCachedNotes(cached);
    setNotes(partitioned.active);
    setTrashedNotes(partitioned.trashed);
  }, []);

  const showNote = useCallback((next: CachedNote) => {
    setNotes((current) => {
      const without = current.filter((note) => note.id !== next.id);
      return next.trashed ? without : [...without, next];
    });
    setTrashedNotes((current) => {
      const without = current.filter((note) => note.id !== next.id);
      return next.trashed ? [...without, next] : without;
    });
  }, []);

  const reportMutationError = useCallback(
    (action: string, cause: unknown): Error => {
      const error = failure(cause, `Could not ${action}`);
      setMutationError(`Could not ${action}: ${error.message}`);
      return error;
    },
    [],
  );

  const refresh = useCallback(async () => {
    const tree = await libraryApi.fetchLibrary();
    const existing = new Map(
      (await db.notes.toArray()).map((note) => [note.id, note]),
    );
    const cachedNotes = tree.notes.map((note) =>
      toCachedNote(note, existing.get(note.id)),
    );

    // Replace all three tables together: they form one navigable offline snapshot.
    await db.transaction("rw", db.projects, db.folders, db.notes, async () => {
      await Promise.all([
        db.projects.clear(),
        db.folders.clear(),
        db.notes.clear(),
      ]);
      await Promise.all([
        db.projects.bulkPut(tree.projects),
        db.folders.bulkPut(tree.folders),
        db.notes.bulkPut(cachedNotes),
      ]);
    });
    setProjects(tree.projects);
    setFolders(tree.folders);
    showCachedNotes(cachedNotes);
    setLoaded(true);
  }, [showCachedNotes]);

  useEffect(() => {
    let cancelled = false;
    void db
      .transaction("r", db.projects, db.folders, db.notes, async () =>
        Promise.all([
          db.projects.toArray(),
          db.folders.toArray(),
          db.notes.toArray(),
        ]),
      )
      .then(([cachedProjects, cachedFolders, cachedNotes]) => {
        if (cancelled) return;
        setProjects(cachedProjects);
        setFolders(cachedFolders);
        showCachedNotes(cachedNotes);
        setLoaded(true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) void refresh().catch(() => setLoaded(true));
      });
    return () => {
      cancelled = true;
    };
  }, [refresh, showCachedNotes]);

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

  const mutateNote = useCallback(
    async (noteId: string, patch: NotePatch, action: string): Promise<void> => {
      const original = [...notes, ...trashedNotes].find(
        (note) => note.id === noteId,
      );
      if (!original) return;
      const optimistic = { ...original, ...patch };
      showNote(optimistic);
      try {
        await db.notes.put(optimistic);
      } catch (cause) {
        showNote(original);
        throw reportMutationError(action, cause);
      }

      let serverNote: Awaited<ReturnType<typeof libraryApi.updateNote>>;
      try {
        serverNote = await libraryApi.updateNote(noteId, patch);
      } catch (cause) {
        await db.notes.put(original).catch(() => undefined);
        showNote(original);
        throw reportMutationError(action, cause);
      }

      const authoritative = toCachedNote(serverNote, original);
      showNote(authoritative);
      try {
        await db.notes.put(authoritative);
        setMutationError(null);
      } catch (cause) {
        // The server action succeeded, so do not roll it back in memory. Surface
        // the cache failure and let the next library refresh repair IndexedDB.
        reportMutationError(`save the ${action} result offline`, cause);
      }
    },
    [notes, reportMutationError, showNote, trashedNotes],
  );

  const addProject = useCallback(async (name: string) => {
    const project = await libraryApi.createProject(name);
    await db.projects.put(project);
    setProjects((current) => [...current, project]);
  }, []);

  const renameProject = useCallback(async (projectId: string, name: string) => {
    const project = await libraryApi.updateProject(projectId, { name });
    await db.projects.put(project);
    setProjects((current) =>
      current.map((item) => (item.id === projectId ? project : item)),
    );
  }, []);

  const deleteProject = useCallback(
    async (projectId: string) => {
      await libraryApi.deleteProject(projectId);
      const allNotes = [...notes, ...trashedNotes];
      const deletedNoteIds = allNotes
        .filter((note) => note.projectId === projectId)
        .map((note) => note.id);
      const deletedFolderIds = folders
        .filter((folder) => folder.projectId === projectId)
        .map((folder) => folder.id);
      await db.transaction(
        "rw",
        db.projects,
        db.folders,
        db.notes,
        async () => {
          await db.projects.delete(projectId);
          await db.folders.bulkDelete(deletedFolderIds);
          await db.notes.bulkDelete(deletedNoteIds);
        },
      );
      setProjects((current) => current.filter((item) => item.id !== projectId));
      setFolders((current) =>
        current.filter((item) => item.projectId !== projectId),
      );
      setNotes((current) =>
        current.filter((note) => note.projectId !== projectId),
      );
      setTrashedNotes((current) =>
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
    [folders, notes, trashedNotes],
  );

  const addFolder = useCallback(
    async (projectId: string, parentId: string | null, name: string) => {
      const folder = await libraryApi.createFolder(projectId, parentId, name);
      await db.folders.put(folder);
      setFolders((current) => [...current, folder]);
    },
    [],
  );

  const renameFolder = useCallback(async (folderId: string, name: string) => {
    const folder = await libraryApi.updateFolder(folderId, { name });
    await db.folders.put(folder);
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
        for (const folder of folders) {
          if (
            folder.parentId &&
            descendants.has(folder.parentId) &&
            !descendants.has(folder.id)
          ) {
            descendants.add(folder.id);
            changed = true;
          }
        }
      }
      const nextNotes = [...notes, ...trashedNotes].map((note) =>
        note.folderId && descendants.has(note.folderId)
          ? { ...note, folderId: null }
          : note,
      );
      await db.transaction("rw", db.folders, db.notes, async () => {
        await db.folders.bulkDelete([...descendants]);
        await db.notes.bulkPut(nextNotes);
      });
      setFolders((current) =>
        current.filter((item) => !descendants.has(item.id)),
      );
      showCachedNotes(nextNotes);
    },
    [folders, notes, showCachedNotes, trashedNotes],
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
      showNote(cached);
      selectNote(note.id);
    },
    [selectNote, showNote],
  );

  const toggleFavorite = useCallback(
    async (noteId: string) => {
      const note = [...notes, ...trashedNotes].find(
        (candidate) => candidate.id === noteId,
      );
      if (note)
        await mutateNote(
          noteId,
          { favorite: !note.favorite },
          "update favorite",
        );
    },
    [mutateNote, notes, trashedNotes],
  );

  const trashNote = useCallback(
    async (noteId: string) => {
      await mutateNote(noteId, { trashed: true }, "move note to trash");
      setSelectedNoteId((current) => (current === noteId ? null : current));
    },
    [mutateNote],
  );

  const restoreNote = useCallback(
    async (noteId: string) => {
      await mutateNote(noteId, { trashed: false }, "restore note");
    },
    [mutateNote],
  );

  const deleteNoteForever = useCallback(
    async (noteId: string) => {
      const original = trashedNotes.find((note) => note.id === noteId);
      if (!original) return;
      setTrashedNotes((current) =>
        current.filter((note) => note.id !== noteId),
      );
      try {
        // Remove the durable local row first so a successful server purge cannot
        // leave an offline ghost if IndexedDB subsequently fails.
        await db.notes.delete(noteId);
        await libraryApi.deleteNoteForever(noteId);
        setRecents((current) => {
          const next = current.filter((id) => id !== noteId);
          localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
          return next;
        });
        setMutationError(null);
      } catch (cause) {
        await db.notes.put(original).catch(() => undefined);
        setTrashedNotes((current) =>
          current.some((note) => note.id === noteId)
            ? current
            : [...current, original],
        );
        throw reportMutationError("delete note permanently", cause);
      }
    },
    [reportMutationError, trashedNotes],
  );

  const renameNote = useCallback(
    async (noteId: string, title: string) => {
      await mutateNote(noteId, { title }, "rename note");
    },
    [mutateNote],
  );

  const value = useMemo<LibraryState>(
    () => ({
      loaded,
      projects,
      folders,
      notes,
      trashedNotes,
      search,
      setSearch,
      recents,
      selectedNoteId,
      selectNote,
      mutationError,
      clearMutationError: () => setMutationError(null),
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
      deleteNoteForever,
      renameNote,
    }),
    [
      loaded,
      projects,
      folders,
      notes,
      trashedNotes,
      search,
      recents,
      selectedNoteId,
      selectNote,
      mutationError,
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
      deleteNoteForever,
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
