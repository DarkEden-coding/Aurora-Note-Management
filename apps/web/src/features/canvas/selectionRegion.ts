// Box and lasso selection geometry, selection bounds, and object cloning for copy, paste, and duplicate.
import type { Bounds, CanvasObject } from "@aurora/shared";
import {
  getLineEndpoints,
  getStrokePoints,
  moveObjectToBounds,
} from "./objects";
import { newId } from "./operations";
import type { Point } from "./viewport";

/** Share of a stroke's points that must fall inside the region to select it. */
const STROKE_INSIDE_RATIO = 0.5;

/** The rectangle spanned by two drag corners, as a closed polygon. */
export function boxPolygon(a: Point, b: Point): Point[] {
  return [
    { x: a.x, y: a.y },
    { x: b.x, y: a.y },
    { x: b.x, y: b.y },
    { x: a.x, y: b.y },
  ];
}

/** Even-odd ray cast; the polygon is treated as closed. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Points that stand for an object's shape when testing region containment. */
function samplePoints(object: CanvasObject): Point[] {
  if (object.kind === "stroke") {
    const points = getStrokePoints(object);
    if (points.length > 0) return points;
  }
  if (object.kind === "line" || object.kind === "arrow") {
    const { start, end } = getLineEndpoints(object);
    return [start, end];
  }
  const { x, y, width, height } = object.bounds;
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

/**
 * Unlocked objects enclosed by a selection region. Ink counts when most of its
 * points are inside, so a rough lasso still catches it; everything else must
 * be fully enclosed, so a box drawn on a large image does not grab the image.
 */
export function objectsInRegion(
  objects: CanvasObject[],
  polygon: Point[],
): CanvasObject[] {
  if (polygon.length < 3) return [];
  const region = unionBounds(
    polygon.map((point) => ({ bounds: { ...point, width: 0, height: 0 } })),
  )!;
  // Points outside the region's box cannot be inside it; skipping them keeps
  // a lasso fast on notes with many strokes far from it.
  const isInside = (point: Point): boolean =>
    point.x >= region.x &&
    point.x <= region.x + region.width &&
    point.y >= region.y &&
    point.y <= region.y + region.height &&
    pointInPolygon(point, polygon);
  return objects.filter((object) => {
    if (object.locked) return false;
    const points = samplePoints(object);
    const inside = points.filter(isInside).length;
    return object.kind === "stroke"
      ? inside >= Math.max(1, points.length * STROKE_INSIDE_RATIO)
      : inside === points.length;
  });
}

/** Smallest bounds containing every object, or null for an empty list. */
export function unionBounds(
  objects: readonly Pick<CanvasObject, "bounds">[],
): Bounds | null {
  if (objects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const { bounds } of objects) {
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export interface CloneTarget {
  ownerId: string;
  noteId: string;
  offset: Point;
  /** zIndex for the lowest clone; clones keep their relative stacking above it. */
  baseZIndex: number;
}

/** Fresh, unsynced copies of objects, moved by an offset and stacked on top. */
export function cloneObjects(
  objects: CanvasObject[],
  target: CloneTarget,
): CanvasObject[] {
  const now = new Date().toISOString();
  return [...objects]
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((object, index) => {
      const moved = moveObjectToBounds(object, {
        ...object.bounds,
        x: object.bounds.x + target.offset.x,
        y: object.bounds.y + target.offset.y,
      });
      return {
        ...moved,
        id: newId(),
        ownerId: target.ownerId,
        noteId: target.noteId,
        pageId: object.noteId === target.noteId ? object.pageId : null,
        zIndex: target.baseZIndex + index,
        locked: false,
        groupId: null,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
    });
}
