// This module hydrates the local IndexedDB cache over HTTP: it requests only the
// axis-aligned viewport region (plus overscan) for one note via the regional query
// route, honoring the regional-read boundary — no endpoint returns every canvas object.
import type { Bounds, RegionalObjectQueryResponse } from "@aurora/shared";
import { apiPost } from "../lib/http.js";
import { db } from "./db.js";

const OVERSCAN = 1.25;

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
 * The noteId travels in the path and the body carries viewport/page filters.
 * A complete regional response also removes cached server objects that disappeared
 * while this device was offline. Queued local objects remain protected.
 */
export async function hydrateRegion(params: {
  noteId: string;
  viewport: Bounds;
  pageId?: string | null;
}): Promise<RegionalObjectQueryResponse & { deletedObjectIds: string[] }> {
  const queriedViewport = expandViewport(params.viewport);
  const response = await apiPost<RegionalObjectQueryResponse>(
    `/api/notes/${params.noteId}/objects/query`,
    {
      viewport: queriedViewport,
      ...(params.pageId !== undefined ? { pageId: params.pageId } : {}),
    },
  );

  let deletedObjectIds: string[] = [];
  await db.transaction("rw", db.objects, db.notes, db.outbox, async () => {
    await db.objects.bulkPut(response.objects);
    if (!response.truncated) {
      const [cached, queued] = await Promise.all([
        db.objects.where("noteId").equals(params.noteId).toArray(),
        db.outbox.toArray(),
      ]);
      const returnedIds = new Set(response.objects.map((object) => object.id));
      const queuedIds = new Set(
        queued
          .filter((row) => row.op.noteId === params.noteId)
          .map((row) => row.op.objectId),
      );
      deletedObjectIds = cached
        .filter(
          (object) =>
            object.bounds.x < queriedViewport.x + queriedViewport.width &&
            object.bounds.x + object.bounds.width > queriedViewport.x &&
            object.bounds.y < queriedViewport.y + queriedViewport.height &&
            object.bounds.y + object.bounds.height > queriedViewport.y &&
            !returnedIds.has(object.id) &&
            !queuedIds.has(object.id),
        )
        .map((object) => object.id);
      await db.objects.bulkDelete(deletedObjectIds);
    }
    const note = await db.notes.get(params.noteId);
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
      favorite: note?.favorite ?? false,
      trashed: note?.trashed ?? false,
      archived: note?.archived ?? false,
      updatedAt: note?.updatedAt ?? new Date().toISOString(),
      lastOpenedAt: note?.lastOpenedAt ?? new Date().toISOString(),
      revision: Math.max(note?.revision ?? 0, maxObjectRevision),
    });
  });

  return { ...response, deletedObjectIds };
}
