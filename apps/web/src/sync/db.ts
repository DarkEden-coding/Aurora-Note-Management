// This module owns Aurora's IndexedDB schema (Dexie): cached library rows, cached canvas objects, the durable outbox, conflict records, and small metadata keys. All offline persistence flows through this database.
import Dexie, { type EntityTable } from "dexie";
import type { Background, CanvasObject, DeleteMarker } from "@aurora/shared";

export interface CachedNote {
  id: string;
  projectId: string;
  folderId: string | null;
  title: string;
  kind: "canvas" | "pdf";
  /** One of the four shared canvas modes; drives the canvas workspace layout. */
  canvasMode: "infinite" | "fixed-width" | "fixed-height" | "paged";
  background: Background;
  favorite: boolean;
  trashed: boolean;
  archived: boolean;
  updatedAt: string;
  lastOpenedAt: string | null;
  /** Highest revision seen locally; hydration and acks advance it. */
  revision: number;
}

export interface CachedObject extends CanvasObject {}

export interface OutboxRow {
  /** The operation ID — the primary key makes enqueueing idempotent. */
  id: string;
  op: import("@aurora/shared").SyncOperation;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  status: "pending" | "failed" | "conflict";
}

export interface ConflictRow {
  id: string;
  noteId: string;
  objectId: string;
  localObject: CanvasObject | DeleteMarker;
  serverObject: CanvasObject | null;
  createdAt: number;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export class AuroraDb extends Dexie {
  notes!: EntityTable<CachedNote, "id">;
  objects!: EntityTable<CachedObject, "id">;
  outbox!: EntityTable<OutboxRow, "id">;
  conflicts!: EntityTable<ConflictRow, "id">;
  meta!: EntityTable<MetaRow, "key">;

  constructor() {
    super("aurora");
    this.version(1).stores({
      notes: "id, projectId, folderId, updatedAt, lastOpenedAt",
      objects: "id, noteId, [noteId+revision], updatedAt",
      outbox: "id, createdAt, nextAttemptAt, status",
      conflicts: "id, noteId, objectId, createdAt",
      meta: "key",
    });
  }
}

export const db = new AuroraDb();
