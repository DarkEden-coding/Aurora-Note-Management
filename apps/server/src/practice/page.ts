// Paged-note geometry for practice: page size, world frames, and page-relative to world conversion (mirrors the web page layout).
import type { Bounds } from "@aurora/shared";
import { invalid } from "../errors.js";

export const PAGE_WIDTH = 816;
export const PAGE_HEIGHT = 1056;
export const PAGE_GAP = 24;

// Prompt and summary cards sit at a fixed page-relative origin and width.
export const CARD_X = 32;
export const CARD_Y = 32;
export const CARD_WIDTH = 752;

export function pageFrame(pageIndex: number): Bounds {
  return {
    x: 0,
    y: pageIndex * (PAGE_HEIGHT + PAGE_GAP),
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
  };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Rejects page-relative bounds that leave the page, so a card never spills into the next one. */
export function checkFitsPage(bounds: Bounds): void {
  if (bounds.x + bounds.width > PAGE_WIDTH + 0.5) {
    throw invalid(`x + width must be at most ${PAGE_WIDTH}`);
  }
  if (bounds.y + bounds.height > PAGE_HEIGHT + 0.5) {
    throw invalid(`y + height must be at most ${PAGE_HEIGHT}`);
  }
}
