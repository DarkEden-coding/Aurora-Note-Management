// This module is Aurora's sync engine: it owns the /sync/ws WebSocket subscription
// and outbox flush loop, routes server broadcasts (objects-changed / note-changed)
// into the local cache using the shared ServerEvent contract, notifies feature
// listeners about remote changes, and stays a single shared instance across the app.
import type { CanvasObject, ServerEvent, SyncConflict } from "@aurora/shared";
import { api } from "../lib/http.js";
import { ReconnectingWebSocket, type SocketState } from "../lib/websocket.js";
import { db } from "./db.js";
import { hydrateRegion } from "./hydrate.js";
import { flushOutbox } from "./outbox.js";
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
}

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_DEBOUNCE_MS = 100;

class SyncEngine {
  private socket: ReconnectingWebSocket | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private scheduledFlush: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private flushAgain = false;
  private hasConnected = false;
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

  getStatus = (): SyncStatus => this.status;

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
          if (this.hasConnected && this.lastHydration) {
            void this.hydrate(
              this.lastHydration.noteId,
              this.lastHydration.viewport,
            );
          }
          this.hasConnected = true;
        },
        onMessage: (data) => void this.handleServerEvent(data as ServerEvent),
      },
    );
    this.socket.connect();

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.requestFlush(0);
    void this.loadConflicts();
    void this.refreshCounts();
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
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
  }

  private handleOnline = (): void => {
    this.setStatus({ online: true });
    this.socket?.reconnect();
    this.requestFlush(0);
    void this.loadConflicts();
  };

  private handleOffline = (): void => {
    this.setStatus({ online: false });
  };

  private handleVisibilityChange = (): void => {
    if (document.visibilityState !== "visible" || !navigator.onLine) return;
    this.socket?.reconnect();
  };

  private async handleServerEvent(event: ServerEvent): Promise<void> {
    if (event.type === "objects-changed") {
      // Never replace a newer local draft with a server snapshot. Its outbox
      // acknowledgement will advance the draft's revision without changing content.
      const changes = filterChangesForPendingOperations(
        event,
        await db.outbox.toArray(),
      );
      await db.transaction("rw", db.objects, async () => {
        await db.objects.bulkPut(changes.objects);
        await db.objects.bulkDelete(changes.deletedObjectIds);
      });
      const maxRevision = event.objects.reduce(
        (max, object) => Math.max(max, object.revision),
        0,
      );
      if (maxRevision > 0) {
        await db.notes
          .update(event.noteId, { revision: maxRevision })
          .catch(() => undefined);
      }
      if (changes.objects.length > 0 || changes.deletedObjectIds.length > 0) {
        this.notifyRemoteChange({ noteId: event.noteId, ...changes });
      }
    }
    // note-changed carries metadata-only updates; counts refresh below.
    this.setStatus({ lastSyncAt: Date.now() });
    await this.refreshCounts();
  }

  /** Deliver reconciled object changes to every active feature listener. */
  private notifyRemoteChange(event: RemoteChangeEvent): void {
    for (const listener of this.remoteListeners) listener(event);
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

  /** Flush soon after durable enqueue, coalescing bursts into one HTTP batch. */
  requestFlush = (delayMs = FLUSH_DEBOUNCE_MS): void => {
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
      const result = await flushOutbox();
      for (const change of result.changes) {
        this.notifyRemoteChange(change);
      }
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
