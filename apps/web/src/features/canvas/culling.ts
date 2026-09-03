// Regional read emulation for the local cache: axis-aligned viewport plus overscan culling over canvas objects. Linear scan is fine at the 1,000-object ceiling.
import type { Bounds, CanvasObject } from "@aurora/shared";
import { boundsIntersect, expandBounds } from "./viewport";

export const DEFAULT_OVERSCAN = 256;

/**
 * Returns every object whose bounds intersect the visible region expanded by `overscan`
 * canvas units, mirroring the server's regional viewport query.
 */
export function queryVisibleObjects(
  objects: CanvasObject[],
  view: Bounds,
  overscan: number = DEFAULT_OVERSCAN,
): CanvasObject[] {
  const region = expandBounds(view, overscan);
  return objects.filter((o) => boundsIntersect(o.bounds, region));
}

/** Ascending z-order sort with a stable tie-break on array position. */
export function sortByZIndex(objects: CanvasObject[]): CanvasObject[] {
  return objects
    .map((o, index) => ({ o, index }))
    .sort((a, b) => a.o.zIndex - b.o.zIndex || a.index - b.index)
    .map((entry) => entry.o);
}

/** Descending z-order: topmost object first, for hit-testing and scene paint order. */
export function sortByZIndexDescending(
  objects: CanvasObject[],
): CanvasObject[] {
  return sortByZIndex(objects).reverse();
}
