// Writes practice canvas objects through the canvas module and broadcasts object and practice changes to the owner's devices.
import crypto from "node:crypto";
import type pg from "pg";
import type { CanvasObject } from "@aurora/shared";
import { deleteObject, touchNote, upsertObject } from "../canvas/objects.js";
import { broadcastToOwner } from "../sync/ws.js";

export type ObjectChanges = {
  noteId: string;
  objects: CanvasObject[];
  deletedObjectIds: string[];
};

/** Inserts and deletes practice objects inside the caller's transaction and bumps the note revision once. */
export async function writeObjects(
  client: pg.PoolClient,
  ownerId: string,
  noteId: string,
  inserts: CanvasObject[],
  deleteIds: string[] = [],
): Promise<ObjectChanges> {
  const objects: CanvasObject[] = [];
  for (const object of inserts) {
    objects.push(await upsertObject(client, ownerId, object, 0));
  }
  const deletedObjectIds: string[] = [];
  for (const id of deleteIds) {
    if (await deleteObject(client, ownerId, id)) deletedObjectIds.push(id);
  }
  if (objects.length > 0 || deletedObjectIds.length > 0) {
    await touchNote(client, ownerId, noteId);
  }
  return { noteId, objects, deletedObjectIds };
}

/** Sends committed object changes to the owner's devices (no-op when nothing changed). */
export function broadcastObjectChanges(
  ownerId: string,
  changes: ObjectChanges,
  originOperationId = `practice:${crypto.randomUUID()}`,
): void {
  if (changes.objects.length === 0 && changes.deletedObjectIds.length === 0) {
    return;
  }
  broadcastToOwner(ownerId, {
    type: "objects-changed",
    noteId: changes.noteId,
    objects: changes.objects,
    deletedObjectIds: changes.deletedObjectIds,
    originOperationId,
    serverTimestamp: new Date().toISOString(),
  });
}

/** Call after commit so devices only ever see committed state. */
export function broadcastChanges(
  ownerId: string,
  sessionId: string,
  noteId: string,
  changes?: ObjectChanges,
  libraryChanged = false,
): void {
  const serverTimestamp = new Date().toISOString();
  if (changes) broadcastObjectChanges(ownerId, changes);
  // New notes and pages change the library tree; devices reload it, and their page counts, on this.
  if (libraryChanged) {
    broadcastToOwner(ownerId, { type: "library-changed", serverTimestamp });
  }
  broadcastToOwner(ownerId, {
    type: "practice-changed",
    noteId,
    sessionId,
    serverTimestamp,
  });
}
