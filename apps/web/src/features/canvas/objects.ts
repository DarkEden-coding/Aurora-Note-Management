// Canvas object domain helpers: payload conventions, factories, hit-testing, bounds math, and per-note object ceilings.
import type { Bounds, CanvasObject } from "@aurora/shared";
import type { Point } from "./viewport";
import { boundsContainPoint, unionBounds } from "./viewport";

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const MIN_BOUNDS_SIZE = 8;

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
}

// ---- Payload conventions -------------------------------------------------
// rich-text:          { doc: ProseMirrorJSON }
// stroke:             { points: [x, y, pressure][], color: string, baseWidth: number }
// line | arrow:       { color: string, strokeWidth: number }
// rectangle | ellipse:{ color: string, fill: string, strokeWidth: number }
// sticky-note:        { text: string, color: string }
// image:              { src: string, alt: string }
// attachment:         { name: string, size: number, fileId: string }
// pdf-page-reference: { sourceNoteId: string, pageNumber: number, pdfUrl?: string }

export function getRichTextDoc(
  o: CanvasObject,
): Record<string, unknown> | null {
  const doc = o.payload.doc;
  return doc && typeof doc === "object"
    ? (doc as Record<string, unknown>)
    : null;
}

export function getStrokePoints(o: CanvasObject): StrokePoint[] {
  const raw = o.payload.points;
  if (!Array.isArray(raw)) return [];
  const points: StrokePoint[] = [];
  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length >= 3) {
      const x = entry[0];
      const y = entry[1];
      const pressure = entry[2];
      if (
        typeof x === "number" &&
        typeof y === "number" &&
        typeof pressure === "number"
      ) {
        points.push({ x, y, pressure });
      }
    }
  }
  return points;
}

export function setStrokePayload(
  points: StrokePoint[],
  color: string,
  baseWidth: number,
): CanvasObject["payload"] {
  return {
    points: points.map((p) => [p.x, p.y, p.pressure]),
    color,
    baseWidth,
  };
}

export function getStrokeColor(o: CanvasObject): string {
  return typeof o.payload.color === "string" ? o.payload.color : "#e6e8ec";
}

export function getStrokeBaseWidth(o: CanvasObject): number {
  const w = o.payload.baseWidth;
  return typeof w === "number" && w > 0 ? w : 2.5;
}

export function getShapeStrokeWidth(o: CanvasObject): number {
  const w = o.payload.strokeWidth;
  return typeof w === "number" && w > 0 ? w : 2;
}

export function getShapeColor(o: CanvasObject): string {
  return typeof o.payload.color === "string" ? o.payload.color : "#e6e8ec";
}

export function getShapeFill(o: CanvasObject): string | null {
  const fill = o.payload.fill;
  return typeof fill === "string" ? fill : null;
}

export function getStickyText(o: CanvasObject): string {
  return typeof o.payload.text === "string" ? o.payload.text : "";
}

export function getStickyColor(o: CanvasObject): string {
  return typeof o.payload.color === "string" ? o.payload.color : "#f7d774";
}

export function getImageSrc(o: CanvasObject): string | null {
  return typeof o.payload.src === "string" ? o.payload.src : null;
}

export function getImageAlt(o: CanvasObject): string {
  return typeof o.payload.alt === "string" ? o.payload.alt : "image";
}

export function getAttachmentName(o: CanvasObject): string {
  return typeof o.payload.name === "string" ? o.payload.name : "attachment";
}

export function getAttachmentSize(o: CanvasObject): number {
  const size = o.payload.size;
  return typeof size === "number" && size >= 0 ? size : 0;
}

export function getAttachmentFileId(o: CanvasObject): string | null {
  return typeof o.payload.fileId === "string" ? o.payload.fileId : null;
}

export interface PdfPageReference {
  sourceNoteId: string;
  pageNumber: number;
  pdfUrl?: string;
}

/** Parses a live embedded page reference payload; `null` when the payload is not a valid reference. */
export function getPdfPageReference(o: CanvasObject): PdfPageReference | null {
  const sourceNoteId = o.payload.sourceNoteId;
  const pageNumber = o.payload.pageNumber;
  if (typeof sourceNoteId !== "string" || sourceNoteId.length === 0)
    return null;
  if (
    typeof pageNumber !== "number" ||
    !Number.isInteger(pageNumber) ||
    pageNumber < 1
  )
    return null;
  const pdfUrl = o.payload.pdfUrl;
  return {
    sourceNoteId,
    pageNumber,
    ...(typeof pdfUrl === "string" ? { pdfUrl } : {}),
  };
}

// ---- Factories -----------------------------------------------------------

export interface MakeCanvasObjectInput {
  id: string;
  ownerId: string;
  noteId: string;
  kind: CanvasObject["kind"];
  bounds: Bounds;
  zIndex: number;
  payload: CanvasObject["payload"];
  pageId?: string | null;
  revision?: number;
}

/** Creates a canvas object with the shared contract's defaults filled in. */
export function makeCanvasObject(input: MakeCanvasObjectInput): CanvasObject {
  const now = new Date().toISOString();
  return {
    id: input.id,
    ownerId: input.ownerId,
    noteId: input.noteId,
    pageId: input.pageId ?? null,
    kind: input.kind,
    bounds: { ...input.bounds },
    rotation: 0,
    zIndex: input.zIndex,
    locked: false,
    groupId: null,
    payload: input.payload,
    revision: input.revision ?? 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function maxZIndex(objects: CanvasObject[]): number {
  let max = 0;
  for (const o of objects) max = Math.max(max, o.zIndex);
  return max;
}

export function nextZIndex(objects: CanvasObject[]): number {
  return maxZIndex(objects) + 1;
}

// ---- Hit-testing ---------------------------------------------------------

/** Topmost object (max zIndex) whose bounds contain the canvas point; `null` on empty space. */
export function hitTestTopmost(
  objects: CanvasObject[],
  p: Point,
): CanvasObject | null {
  let best: CanvasObject | null = null;
  for (const o of objects) {
    if (!boundsContainPoint(o.bounds, p)) continue;
    if (best === null || o.zIndex >= best.zIndex) best = o;
  }
  return best;
}

// ---- Geometry ------------------------------------------------------------

export function pointsToBounds(points: StrokePoint[], padding: number): Bounds {
  const padded = points.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 }));
  const inner = unionBounds(padded) ?? {
    x: 0,
    y: 0,
    width: MIN_BOUNDS_SIZE,
    height: MIN_BOUNDS_SIZE,
  };
  return {
    x: inner.x - padding,
    y: inner.y - padding,
    width: Math.max(MIN_BOUNDS_SIZE, inner.width + padding * 2),
    height: Math.max(MIN_BOUNDS_SIZE, inner.height + padding * 2),
  };
}

export function dragBoundsFree(start: Point, current: Point): Bounds {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

/** Line/arrow drag: the dominant axis of the gesture defines the bounds. */
export function dragBoundsAxis(start: Point, current: Point): Bounds {
  const isHorizontal =
    Math.abs(current.x - start.x) >= Math.abs(current.y - start.y);
  return {
    x: isHorizontal ? Math.min(start.x, current.x) : start.x,
    y: isHorizontal ? start.y : Math.min(start.y, current.y),
    width: isHorizontal ? Math.abs(current.x - start.x) : MIN_BOUNDS_SIZE,
    height: isHorizontal ? MIN_BOUNDS_SIZE : Math.abs(current.y - start.y),
  };
}

/** Applies a resize gesture to a start bounds with start/current canvas points for the given handle. */
export function applyResize(
  startBounds: Bounds,
  handle: Handle,
  start: Point,
  current: Point,
): Bounds {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  let { x, y, width, height } = startBounds;
  if (handle.includes("w")) {
    x = startBounds.x + dx;
    width = startBounds.width - dx;
  }
  if (handle.includes("e")) {
    width = startBounds.width + dx;
  }
  if (handle.includes("n")) {
    y = startBounds.y + dy;
    height = startBounds.height - dy;
  }
  if (handle.includes("s")) {
    height = startBounds.height + dy;
  }
  width = Math.max(MIN_BOUNDS_SIZE, width);
  height = Math.max(MIN_BOUNDS_SIZE, height);
  return { x, y, width, height };
}

export function handlePositions(
  b: Bounds,
): Array<{ handle: Handle; point: Point }> {
  const { x, y, width, height } = b;
  return [
    { handle: "nw", point: { x, y } },
    { handle: "n", point: { x: x + width / 2, y } },
    { handle: "ne", point: { x: x + width, y } },
    { handle: "e", point: { x: x + width, y: y + height / 2 } },
    { handle: "se", point: { x: x + width, y: y + height } },
    { handle: "s", point: { x: x + width / 2, y: y + height } },
    { handle: "sw", point: { x, y: y + height } },
    { handle: "w", point: { x, y: y + height / 2 } },
  ];
}

export function handleAtPoint(
  b: Bounds,
  p: Point,
  tolerance: number,
): Handle | null {
  for (const { handle, point } of handlePositions(b)) {
    if (
      Math.abs(point.x - p.x) <= tolerance &&
      Math.abs(point.y - p.y) <= tolerance
    )
      return handle;
  }
  return null;
}

/** Renormalizes a stroke object's bounds so they tightly cover its payload points. */
export function recomputeStrokeBounds(o: CanvasObject): Bounds {
  const points = getStrokePoints(o);
  return pointsToBounds(points, getStrokeBaseWidth(o) * 2);
}
