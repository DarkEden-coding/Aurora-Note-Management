// Pure reconciliation rules used by regional hydration. Keeping these rules
// independent of IndexedDB makes the race guarantees directly testable.
import type { Bounds, CanvasObject } from "@aurora/shared";

/** Assigns monotonically increasing request generations independently per note. */
export class HydrationGenerations {
  private readonly currentByNote = new Map<string, number>();

  begin(noteId: string): number {
    const generation = (this.currentByNote.get(noteId) ?? 0) + 1;
    this.currentByNote.set(noteId, generation);
    return generation;
  }

  isCurrent(noteId: string, generation: number): boolean {
    return this.currentByNote.get(noteId) === generation;
  }
}

/** A hydration snapshot may only replace an object when it is strictly newer. */
export function newerHydratedObjects(
  incoming: readonly CanvasObject[],
  cached: readonly (CanvasObject | undefined)[],
): CanvasObject[] {
  return incoming.filter((object, index) => {
    const current = cached[index];
    return current === undefined || object.revision > current.revision;
  });
}

function overlaps(bounds: Bounds, viewport: Bounds): boolean {
  return (
    bounds.x < viewport.x + viewport.width &&
    bounds.x + bounds.width > viewport.x &&
    bounds.y < viewport.y + viewport.height &&
    bounds.y + bounds.height > viewport.y
  );
}

/**
 * Absence is safe to interpret as deletion only for an object that was present
 * when this HTTP request started and has not changed since. Objects created or
 * revised by WebSocket while the request was in flight are therefore protected.
 */
export function safeMissingObjectIds(params: {
  cached: readonly CanvasObject[];
  returnedIds: ReadonlySet<string>;
  queuedIds: ReadonlySet<string>;
  startRevisions: ReadonlyMap<string, number>;
  viewport: Bounds;
}): string[] {
  return params.cached
    .filter(
      (object) =>
        overlaps(object.bounds, params.viewport) &&
        !params.returnedIds.has(object.id) &&
        !params.queuedIds.has(object.id) &&
        params.startRevisions.get(object.id) === object.revision,
    )
    .map((object) => object.id);
}
