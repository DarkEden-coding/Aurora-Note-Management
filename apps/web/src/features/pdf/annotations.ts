// Page-relative annotation geometry and live PDF page reference representation for embedded page references. Coordinates stay page-relative so annotations resolve at paint time; references resolve live against the source note through the app shell's note index.
import type { Bounds } from "@aurora/shared";

export interface Point {
  x: number;
  y: number;
}

export interface PageRelativeRect {
  /** Page-relative fractions (0..1 from the page's top-left). */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Converts a page-absolute point into page-relative fractions. */
export function toPageRelative(p: Point, page: Bounds): Point {
  return {
    x: page.width > 0 ? clamp01((p.x - page.x) / page.width) : 0,
    y: page.height > 0 ? clamp01((p.y - page.y) / page.height) : 0,
  };
}

/** Converts page-relative fractions back into a page-absolute point. */
export function fromPageRelative(p: Point, page: Bounds): Point {
  return { x: page.x + p.x * page.width, y: page.y + p.y * page.height };
}

/** Converts a page-absolute rect into page-relative fractions. */
export function rectToPageRelative(b: Bounds, page: Bounds): PageRelativeRect {
  const width = page.width > 0 ? clamp01(b.width / page.width) : 0;
  const height = page.height > 0 ? clamp01(b.height / page.height) : 0;
  const origin = toPageRelative({ x: b.x, y: b.y }, page);
  return { x: origin.x, y: origin.y, width, height };
}

/** Converts page-relative fractions back into a page-absolute rect. */
export function rectFromPageRelative(
  r: PageRelativeRect,
  page: Bounds,
): Bounds {
  const origin = fromPageRelative({ x: r.x, y: r.y }, page);
  return {
    x: origin.x,
    y: origin.y,
    width: r.width * page.width,
    height: r.height * page.height,
  };
}

export interface LivePageReference {
  /** Note id of the source document; references resolve live against that note. */
  sourceNoteId: string;
  /** One-based page number in the source document. */
  pageNumber: number;
  /** Page-relative anchor rect; omitted anchors resolve to the full page. */
  rect?: PageRelativeRect;
  /** Resolved source asset URL; the app shell supplies it from its note index. */
  pdfUrl?: string;
}

const PAGE_NUMBER_MIN = 1;

/** Parses a live page reference from an object payload record; `null` when not a valid reference. */
export function parseLivePageReference(
  payload: Record<string, unknown>,
): LivePageReference | null {
  const sourceNoteId = payload.sourceNoteId;
  const pageNumber = payload.pageNumber;
  if (typeof sourceNoteId !== "string" || sourceNoteId.length === 0)
    return null;
  if (
    typeof pageNumber !== "number" ||
    !Number.isInteger(pageNumber) ||
    pageNumber < PAGE_NUMBER_MIN
  )
    return null;
  const ref: LivePageReference = { sourceNoteId, pageNumber };
  const rect = payload.rect;
  if (isPageRelativeRect(rect)) ref.rect = rect;
  const pdfUrl = payload.pdfUrl;
  if (typeof pdfUrl === "string" && pdfUrl.length > 0) ref.pdfUrl = pdfUrl;
  return ref;
}

/** Serializes a live page reference into an object payload record. */
export function serializeLivePageReference(
  ref: LivePageReference,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    sourceNoteId: ref.sourceNoteId,
    pageNumber: ref.pageNumber,
  };
  if (ref.rect) payload.rect = { ...ref.rect };
  if (ref.pdfUrl) payload.pdfUrl = ref.pdfUrl;
  return payload;
}

/** Human description for reference chrome ("→ Note #Page"). */
export function describePageReference(ref: LivePageReference): string {
  const shortNote = ref.sourceNoteId.slice(0, 8);
  return `→ ${shortNote} #${ref.pageNumber}`;
}

function isPageRelativeRect(value: unknown): value is PageRelativeRect {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  return (
    typeof rect.x === "number" &&
    typeof rect.y === "number" &&
    typeof rect.width === "number" &&
    typeof rect.height === "number"
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
