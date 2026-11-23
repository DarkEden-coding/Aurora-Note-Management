// This module is Aurora's sync engine: it owns the /sync/ws WebSocket subscription
// and outbox flush loop, routes server broadcasts (objects-changed / note-changed / practice-changed)
// into the local cache using the shared ServerEvent contract, notifies feature
// listeners about remote changes, and stays a single shared instance across the app.
// Sync runs only while Aurora is visible: hiding the page flushes pending edits once,
// then closes the socket and stops the flush timer so a backgrounded tablet can sleep.
import type { CanvasObject, ServerEvent, SyncConflict } from "@aurora/shared";
import { api } from "../lib/http.js";
import { ReconnectingWebSocket, type SocketState } from "../lib/websocket.js";
import { db } from "./db.js";
import { hydrateRegion } from "./hydrate.js";
import {
  countPendingNoteOperations,
  flushOutbox,
  makeNoteOperationsDue,
  waitForPendingEnqueues,
} from "./outbox.js";
import { filterChangesForPendingOperations } from "./outboxCore.js";

export interface SyncStatus {
  state: SocketState;
  pendingOperations: number;
  conflicts: number;
  lastSyncAt: number | null;
  online: boolean;
}

/** Payload delivered to remote-change listeners (feature modules, e.g. the canvas). */
export interface RemoteChangeEvent {
  noteId: string;
  objects: CanvasObject[];
  deletedObjectIds: string[];
  acknowledgement?: true;
}

/** A guided-practice session on a note changed on the server. */
export interface PracticeChangeEvent {
  noteId: string;
  sessionId: string;
}

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_DEBOUNCE_MS = 100;
const NOTE_SYNC_TIMEOUT_MS = 15_000;
const NOTE_SYNC_POLL_MS = 400;

class SyncEngine {
  private socket: ReconnectingWebSocket | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private scheduledFlush: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private flushAgain = false;
  private hasConnected = false;
  private paused = false;
  private lastHydration: {
    noteId: string;
    viewport: { x: number; y: number; width: number; height: number };
  } | null = null;
  private status: SyncStatus = {
    state: "closed",
    pendingOperations: 0,
    conflicts: 0,
    lastSyncAt: null,
    online: navigator.onLine,
  };
  private listeners = new Set<() => void>();
  private remoteListeners = new Set<(event: RemoteChangeEvent) => void>();
  private libraryListeners = new Set<() => void>();
  private practiceListeners = new Set<(event: PracticeChangeEvent) => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Subscribe to remote broadcasts so live views can merge server objects. */
  onRemoteChange = (
    listener: (event: RemoteChangeEvent) => void,
  ): (() => void) => {
    this.remoteListeners.add(listener);
    return () => this.remoteListeners.delete(listener);
  };

  /** Subscribe to project, folder, and note metadata changes. */
  onLibraryChange = (listener: () => void): (() => void) => {
    this.libraryListeners.add(listener);
    return () => this.libraryListeners.delete(listener);
  };

  /** Subscribe to practice-changed broadcasts so the practice header can refetch. */
  onPracticeChanged = (
    listener: (event: PracticeChangeEvent) => void,
  ): (() => void) => {
    this.practiceListeners.add(listener);
    return () => this.practiceListeners.delete(listener);
  };

  getStatus = (): SyncStatus => this.status;

  /**
   * Resolve once the server has acknowledged every queued operation for the
   * note, so server-side reads see what the user sees. Rejects when offline or
   * when the outbox does not drain within the timeout.
   */
  waitForNoteSynced = async (
    noteId: string,
    timeoutMs = NOTE_SYNC_TIMEOUT_MS,
  ): Promise<void> => {
    await waitForPendingEnqueues(noteId);
    if ((await countPendingNoteOperations(noteId)) === 0) return;
    await makeNoteOperationsDue(noteId);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!navigator.onLine) {
        throw new Error("You're offline. Reconnect to send your work.");
      }
      this.requestFlush(0);
      await new Promise((resolve) => setTimeout(resolve, NOTE_SYNC_POLL_MS));
      if ((await countPendingNoteOperations(noteId)) === 0) return;
      if (Date.now() >= deadline) {
        throw new Error(
          "Your latest strokes haven't synced yet. Check the connection and try again.",
        );
      }
    }
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit();
  }

  async refreshCounts(): Promise<void> {
    const [pendingOperations, conflicts] = await Promise.all([
      db.outbox.count(),
      db.conflicts.count(),
    ]);
    this.setStatus({ pendingOperations, conflicts });
  }

  start(): void {
    if (this.socket) return;

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    this.socket = new ReconnectingWebSocket(
      `${protocol}://${location.host}/sync/ws`,
      {
        onState: (state) => {
          this.setStatus({ state });
          if (state !== "open") return;
          this.requestFlush(0);
          if (this.hasConnected) {
            if (this.lastHydration) {
              void this.hydrate(
                this.lastHydration.noteId,
                this.lastHydration.viewport,
              );
            }
            this.notifyLibraryChange();
          }
          this.hasConnected = true;
        },
        onMessage: (data) => void this.handleServerEvent(data as ServerEvent),
      },
    );
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    void this.refreshCounts();
    if (document.visibilityState === "visible") {
      this.resume();
    } else {
      this.paused = true;
    }
  }

  /** Reconnect and resume flushing; the reconnect re-hydrates what changed while paused. */
  private resume(): void {
    this.paused = false;
    this.socket?.connect();
    if (this.flushTimer === null) {
      this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
    this.requestFlush(0);
    void this.loadConflicts();
  }

  /** Send queued edits once, then stop all background network activity. */
  private pause(): void {
    this.paused = true;
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.scheduledFlush !== null) clearTimeout(this.scheduledFlush);
    this.scheduledFlush = null;
    void this.flush();
    this.socket?.close();
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.scheduledFlush !== null) clearTimeout(this.scheduledFlush);
    this.scheduledFlush = null;
    this.flushAgain = false;
    this.hasConnected = false;
    this.paused = false;
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  private handleOnline = (): void => {
    this.setStatus({ online: true });
    if (this.paused) return;
    this.socket?.reconnect();
    this.requestFlush(0);
    void this.loadConflicts();
  };

  private handleOffline = (): void => {
    this.setStatus({ online: false });
  };

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      if (this.paused) this.resume();
    } else if (!this.paused) {
      this.pause();
    }
  };

  private async handleServerEvent(event: ServerEvent): Promise<void> {
    if (event.type === "objects-changed") {
      // Never replace a newer local draft with a server snapshot. Its outbox
      // acknowledgement will advance the draft's revision without changing content.
      const changes = await db.transaction(
        "rw",
        db.outbox,
        db.objects,
        async () => {
          const ids = [
            ...event.objects.map((object) => object.id),
            ...event.deletedObjectIds,
          ];
          const pending = await db.outbox
            .where("objectId")
            .anyOf(ids)
            .toArray();
          const filtered = filterChangesForPendingOperations(event, pending);
          await db.objects.bulkPut(filtered.objects);
          await db.objects.bulkDelete(filtered.deletedObjectIds);
          return filtered;
        },
      );
      const revision =
        event.noteRevision ??
        event.objects.reduce(
          (max, object) => Math.max(max, object.revision),
          0,
        );
      if (revision > 0) {
        await db.notes
          .update(event.noteId, { revision })
          .catch(() => undefined);
      }
      if (changes.objects.length > 0 || changes.deletedObjectIds.length > 0) {
        this.notifyRemoteChange({ noteId: event.noteId, ...changes });
      }
    }
    if (event.type === "library-changed" || event.type === "note-changed") {
      this.notifyLibraryChange();
    }
    if (event.type === "practice-changed") {
      for (const listener of this.practiceListeners) {
        listener({ noteId: event.noteId, sessionId: event.sessionId });
      }
    }
    this.setStatus({ lastSyncAt: Date.now() });
    await this.refreshCounts();
  }

  /** Deliver reconciled object changes to every active feature listener. */
  private notifyRemoteChange(event: RemoteChangeEvent): void {
    for (const listener of this.remoteListeners) listener(event);
  }

  /** Tell the library cache to fetch the authoritative metadata tree. */
  private notifyLibraryChange(): void {
    for (const listener of this.libraryListeners) listener();
  }

  /** Refresh unresolved server conflicts so lost responses and other devices remain visible. */
  private async loadConflicts(): Promise<void> {
    try {
      const response = await api<{ conflicts: SyncConflict[] }>(
        "/api/sync/conflicts",
      );
      await db.transaction("rw", db.conflicts, async () => {
        await db.conflicts.clear();
        await db.conflicts.bulkPut(
          response.conflicts.map((conflict) => ({
            id: conflict.id,
            noteId: conflict.noteId,
            objectId: conflict.objectId,
            localObject: conflict.incomingObject,
            serverObject: conflict.baseObject,
            createdAt: Date.parse(conflict.createdAt),
          })),
        );
      });
    } catch {
      return;
    }
  }

  /** Trigger hydration of the visible region of a note (called when the canvas viewport changes). */
  async hydrate(
    noteId: string,
    viewport: { x: number; y: number; width: number; height: number },
  ): Promise<void> {
    this.lastHydration = { noteId, viewport };
    // Delta hydration (sinceRevision) is only valid once objects exist in the
    // cache; a first open must fetch the region without a revision filter.
    const response = await hydrateRegion({ noteId, viewport }).catch(
      () => null,
    );
    if (response) {
      this.notifyRemoteChange({
        noteId,
        objects: response.objects,
        deletedObjectIds: response.deletedObjectIds,
      });
    }
    await this.refreshCounts();
  }

  /** Flushes current edits before a structural note mutation such as page insertion. */
  async flushNow(noteId: string): Promise<void> {
    if (!navigator.onLine)
      throw new Error("Connect to the server to add a page");
    await waitForPendingEnqueues(noteId);
    if (this.scheduledFlush !== null) {
      clearTimeout(this.scheduledFlush);
      this.scheduledFlush = null;
    }
    while (this.flushing) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await this.flush();
    const pending = (await db.outbox.toArray()).some(
      (row) => row.op.noteId === noteId,
    );
    if (pending) throw new Error("Wait for this note to finish syncing first");
  }

  /** Flush soon after durable enqueue, coalescing bursts into one HTTP batch. */
  requestFlush = (delayMs = FLUSH_DEBOUNCE_MS): void => {
    if (this.paused) return;
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    if (this.scheduledFlush !== null) {
      clearTimeout(this.scheduledFlush);
    }
    this.scheduledFlush = setTimeout(() => {
      this.scheduledFlush = null;
      void this.flush();
    }, delayMs);
  };

  private async flush(): Promise<void> {
    if (this.flushing || !navigator.onLine) return;
    this.flushing = true;
    try {
      await flushOutbox((changes) => {
        for (const change of changes) this.notifyRemoteChange(change);
      });
      await this.refreshCounts();
      this.setStatus({ lastSyncAt: Date.now() });
    } finally {
      this.flushing = false;
      if (this.flushAgain) {
        this.flushAgain = false;
        this.requestFlush(0);
      }
    }
  }
}

export const syncEngine = new SyncEngine();
