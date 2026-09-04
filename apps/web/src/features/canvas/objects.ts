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
// line | arrow:       { start, end, color, strokeWidth, lineStyle }
// rectangle | ellipse:{ color, fill, strokeWidth, lineStyle, cornerRadius? }
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

export type ShapeLineStyle = "solid" | "dashed" | "dotted";

/** Reads a supported vector outline style with a legacy solid fallback. */
export function getShapeLineStyle(o: CanvasObject): ShapeLineStyle {
  const style = o.payload.lineStyle;
  return style === "dashed" || style === "dotted" ? style : "solid";
}

/** Reads rectangle corner radius, constrained to the supported control range. */
export function getShapeCornerRadius(o: CanvasObject): number {
  const radius = o.payload.cornerRadius;
  return typeof radius === "number" && Number.isFinite(radius)
    ? Math.max(0, Math.min(64, radius))
    : 2;
}

/** Converts vector outline style to an SVG dash pattern. */
export function getShapeDashArray(o: CanvasObject): string | undefined {
  const width = getShapeStrokeWidth(o);
  switch (getShapeLineStyle(o)) {
    case "dashed":
      return `${width * 4} ${width * 3}`;
    case "dotted":
      return `0 ${width * 2.5}`;
    case "solid":
      return undefined;
  }
}

export interface LineEndpoints {
  start: Point;
  end: Point;
}

export interface ArrowHeadGeometry {
  wing1: Point;
  wing2: Point;
}

/** Calculates the two arrowhead wings used by rendering and hit testing. */
export function getArrowHeadGeometry(
  start: Point,
  end: Point,
): ArrowHeadGeometry {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const head = Math.min(18, Math.max(8, length / 4));
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const spread = Math.PI / 7;
  return {
    wing1: {
      x: end.x - head * Math.cos(angle - spread),
      y: end.y - head * Math.sin(angle - spread),
    },
    wing2: {
      x: end.x - head * Math.cos(angle + spread),
      y: end.y - head * Math.sin(angle + spread),
    },
  };
}

function payloadPoint(value: unknown): Point | null {
  if (value === null || typeof value !== "object") return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y)
    ? { x, y }
    : null;
}

/**
 * Reads directional line geometry. Legacy objects without endpoint payloads retain
 * their previous rendering: lines cross the horizontal centre, arrows use the
 * bounds' top-left and bottom-right corners.
 */
export function getLineEndpoints(object: CanvasObject): LineEndpoints {
  const start = payloadPoint(object.payload.start);
  const end = payloadPoint(object.payload.end);
  if (start !== null && end !== null) return { start, end };

  const b = object.bounds;
  return object.kind === "line"
    ? {
        start: { x: b.x, y: b.y + b.height / 2 },
        end: { x: b.x + b.width, y: b.y + b.height / 2 },
      }
    : {
        start: { x: b.x, y: b.y },
        end: { x: b.x + b.width, y: b.y + b.height },
      };
}

/** Adds canonical endpoint fields while retaining style or other payload data. */
export function setLineEndpointPayload(
  start: Point,
  end: Point,
  payload: CanvasObject["payload"] = {},
): CanvasObject["payload"] {
  return {
    ...payload,
    start: { x: start.x, y: start.y },
    end: { x: end.x, y: end.y },
  };
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

/** True when a point is close to a rendered line or arrow shaft. */
export function hitTestLineObject(
  object: CanvasObject,
  point: Point,
  tolerance: number,
): boolean {
  if (object.kind !== "line" && object.kind !== "arrow") return false;
  const { start, end } = getLineEndpoints(object);
  if (distanceToSegment(point, start, end) <= tolerance) return true;
  if (object.kind === "line") return false;
  const { wing1, wing2 } = getArrowHeadGeometry(start, end);
  return (
    distanceToSegment(point, end, wing1) <= tolerance ||
    distanceToSegment(point, end, wing2) <= tolerance
  );
}

/** Topmost stroke whose rendered path is within the supplied canvas-space tolerance. */
export function hitTestTopmostStroke(
  objects: CanvasObject[],
  p: Point,
  tolerance: number,
): CanvasObject | null {
  let best: CanvasObject | null = null;
  for (const object of objects) {
    if (object.kind !== "stroke" || object.locked) continue;
    const points = getStrokePoints(object);
    const hit = points.some((point, index) => {
      const previous = points[index - 1];
      return previous === undefined
        ? Math.hypot(point.x - p.x, point.y - p.y) <= tolerance
        : distanceToSegment(p, previous, point) <= tolerance;
    });
    if (hit && (best === null || object.zIndex >= best.zIndex)) best = object;
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

/** Translates captured stroke points without changing pressure. */
export function translateStrokePoints(
  points: StrokePoint[],
  dx: number,
  dy: number,
): StrokePoint[] {
  return points.map((point) => ({
    ...point,
    x: point.x + dx,
    y: point.y + dy,
  }));
}

/** Resizes vector endpoint payloads with their selection bounds. */
export function resizeObjectToBounds(
  object: CanvasObject,
  bounds: Bounds,
): CanvasObject {
  if (object.kind !== "line" && object.kind !== "arrow") {
    return { ...object, bounds };
  }
  const start = payloadPoint(object.payload.start);
  const end = payloadPoint(object.payload.end);
  if (start === null || end === null) return { ...object, bounds };
  const scaleX = bounds.width / object.bounds.width;
  const scaleY = bounds.height / object.bounds.height;
  const resizePoint = (point: Point): Point => ({
    x: bounds.x + (point.x - object.bounds.x) * scaleX,
    y: bounds.y + (point.y - object.bounds.y) * scaleY,
  });
  return {
    ...object,
    bounds,
    payload: setLineEndpointPayload(
      resizePoint(start),
      resizePoint(end),
      object.payload,
    ),
  };
}

/** Moves an object to translated bounds, keeping coordinate payloads aligned. */
export function moveObjectToBounds(
  object: CanvasObject,
  bounds: Bounds,
): CanvasObject {
  const dx = bounds.x - object.bounds.x;
  const dy = bounds.y - object.bounds.y;
  if (object.kind === "line" || object.kind === "arrow") {
    // Do not materialize endpoints for legacy objects: their fallback remains
    // bounds-relative and therefore already follows the move.
    const start = payloadPoint(object.payload.start);
    const end = payloadPoint(object.payload.end);
    if (start === null || end === null) return { ...object, bounds };
    return {
      ...object,
      bounds,
      payload: setLineEndpointPayload(
        { x: start.x + dx, y: start.y + dy },
        { x: end.x + dx, y: end.y + dy },
        object.payload,
      ),
    };
  }
  if (object.kind !== "stroke") return { ...object, bounds };
  const points = translateStrokePoints(getStrokePoints(object), dx, dy);
  return {
    ...object,
    bounds,
    payload: {
      ...object.payload,
      points: points.map((point) => [point.x, point.y, point.pressure]),
    },
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

export interface LineDragGeometry extends LineEndpoints {
  bounds: Bounds;
}

/**
 * Derives directional endpoints and selection bounds from a drag. When requested,
 * the end is snapped to the nearest multiple of 45 degrees without changing the
 * gesture's length. Direction is never normalized, so reverse arrows stay reverse.
 */
export function lineGeometryFromDrag(
  start: Point,
  current: Point,
  snapTo45Degrees = false,
  padding = 0,
): LineDragGeometry {
  let end = { ...current };
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  if (snapTo45Degrees && (dx !== 0 || dy !== 0)) {
    const length = Math.hypot(dx, dy);
    const increment = Math.PI / 4;
    const angle = Math.round(Math.atan2(dy, dx) / increment) * increment;
    end = {
      x: start.x + Math.cos(angle) * length,
      y: start.y + Math.sin(angle) * length,
    };
  }

  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const rawWidth = Math.abs(end.x - start.x);
  const rawHeight = Math.abs(end.y - start.y);
  return {
    start: { ...start },
    end,
    bounds: {
      x: left - Math.max(0, MIN_BOUNDS_SIZE - rawWidth) / 2 - padding,
      y: top - Math.max(0, MIN_BOUNDS_SIZE - rawHeight) / 2 - padding,
      width: Math.max(MIN_BOUNDS_SIZE, rawWidth) + padding * 2,
      height: Math.max(MIN_BOUNDS_SIZE, rawHeight) + padding * 2,
    },
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

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0)
    return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        (dx * dx + dy * dy),
    ),
  );
  return Math.hypot(
    point.x - (start.x + ratio * dx),
    point.y - (start.y + ratio * dy),
  );
}
