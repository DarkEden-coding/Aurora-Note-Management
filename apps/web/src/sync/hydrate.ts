// This module hydrates the local IndexedDB cache over HTTP: it requests only the
// axis-aligned viewport region (plus overscan) for one note via the regional query
// route, honoring the regional-read boundary — no endpoint returns every canvas object.
import type { Bounds, RegionalObjectQueryResponse } from "@aurora/shared";
import { apiPost } from "../lib/http.js";
import { db } from "./db.js";
import {
  HydrationGenerations,
  newerHydratedObjects,
  safeMissingObjectIds,
} from "./hydrateCore.js";
import { filterChangesForPendingOperations } from "./outboxCore.js";

const OVERSCAN = 1.25;
const generations = new HydrationGenerations();

export function expandViewport(viewport: Bounds): Bounds {
  const padX = (viewport.width * (OVERSCAN - 1)) / 2;
  const padY = (viewport.height * (OVERSCAN - 1)) / 2;
  return {
    x: viewport.x - padX,
    y: viewport.y - padY,
    width: viewport.width * OVERSCAN,
    height: viewport.height * OVERSCAN,
  };
}

/**
 * Fetch the regional objects for one note and merge them into the local cache.
 * Only the latest request generation for a note may apply. In addition, object
 * revisions and a start-of-request revision snapshot protect WebSocket writes
 * that arrive while HTTP hydration is in flight.
 */
export async function hydrateRegion(params: {
  noteId: string;
  viewport: Bounds;
  pageId?: string | null;
}): Promise<RegionalObjectQueryResponse & { deletedObjectIds: string[] }> {
  const generation = generations.begin(params.noteId);
  const queriedViewport = expandViewport(params.viewport);
  const cachedAtStart = await db.objects
    .where("noteId")
    .equals(params.noteId)
    .toArray();
  const startRevisions = new Map(
    cachedAtStart.map((object) => [object.id, object.revision]),
  );

  const response = await apiPost<RegionalObjectQueryResponse>(
    `/api/notes/${params.noteId}/objects/query`,
    {
      viewport: queriedViewport,
      ...(params.pageId !== undefined ? { pageId: params.pageId } : {}),
    },
  );

  // A superseded response must not mutate IndexedDB or the active canvas.
  if (!generations.isCurrent(params.noteId, generation)) {
    return { ...response, objects: [], deletedObjectIds: [] };
  }

  let visibleObjects: RegionalObjectQueryResponse["objects"] = [];
  let deletedObjectIds: string[] = [];
  await db.transaction("rw", db.objects, db.notes, db.outbox, async () => {
    if (!generations.isCurrent(params.noteId, generation)) return;

    const queued = await db.outbox.toArray();
    const pendingSafeObjects = filterChangesForPendingOperations(
      { objects: response.objects, deletedObjectIds: [] },
      queued,
    ).objects;
    const currentObjects = await db.objects.bulkGet(
      pendingSafeObjects.map((object) => object.id),
    );
    visibleObjects = newerHydratedObjects(pendingSafeObjects, currentObjects);

    if (!generations.isCurrent(params.noteId, generation)) return;
    await db.objects.bulkPut(visibleObjects);
    if (!generations.isCurrent(params.noteId, generation)) return;

    if (!response.truncated) {
      const cached = await db.objects
        .where("noteId")
        .equals(params.noteId)
        .toArray();
      const returnedIds = new Set(response.objects.map((object) => object.id));
      const queuedIds = new Set(
        queued
          .filter((row) => row.op.noteId === params.noteId)
          .map((row) => row.op.objectId),
      );
      deletedObjectIds = safeMissingObjectIds({
        cached,
        returnedIds,
        queuedIds,
        startRevisions,
        viewport: queriedViewport,
      });
      if (!generations.isCurrent(params.noteId, generation)) return;
      await db.objects.bulkDelete(deletedObjectIds);
    }

    const note = await db.notes.get(params.noteId);
    if (!generations.isCurrent(params.noteId, generation)) return;
    const maxObjectRevision = response.objects.reduce(
      (max, object) => Math.max(max, object.revision),
      0,
    );
    await db.notes.put({
      id: params.noteId,
      projectId: note?.projectId ?? "",
      folderId: note?.folderId ?? null,
      title: note?.title ?? "Untitled",
      kind: note?.kind ?? "canvas",
      canvasMode: note?.canvasMode ?? "infinite",
      background: note?.background ?? {
        pattern: "dot-grid",
        color: "#1b1d21",
        patternColor: "#3a3f4a",
        spacing: 24,
      },
      favorite: note?.favorite ?? false,
      trashed: note?.trashed ?? false,
      archived: note?.archived ?? false,
      updatedAt: note?.updatedAt ?? new Date().toISOString(),
      lastOpenedAt: note?.lastOpenedAt ?? new Date().toISOString(),
      revision: Math.max(note?.revision ?? 0, maxObjectRevision),
    });
  });

  if (!generations.isCurrent(params.noteId, generation)) {
    return { ...response, objects: [], deletedObjectIds: [] };
  }
  return { ...response, objects: visibleObjects, deletedObjectIds };
}
