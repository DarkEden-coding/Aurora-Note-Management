// Splits any note into 816 x 1056 pages so agents read and mark every note in the practice tools' page-relative coordinates.
import type { Bounds } from "@aurora/shared";
import {
  PAGE_HEIGHT,
  PAGE_GAP,
  PAGE_WIDTH,
  boundsIntersect,
  pageFrame,
} from "../practice/page.js";

export type NotePage = {
  index: number;
  // World position of the page's top-left corner; page-relative (x, y) is world (origin.x + x, origin.y + y).
  origin: { x: number; y: number };
};

export function pageWorldFrame(page: NotePage): Bounds {
  return { ...page.origin, width: PAGE_WIDTH, height: PAGE_HEIGHT };
}

/** Paged notes: the persisted pages, plus any page that only content reaches. */
export function pagedNotePages(
  pageCount: number,
  contentBoxes: Bounds[],
): NotePage[] {
  // Same rule as migration 009: the page holding each object's bottom edge.
  const stride = PAGE_HEIGHT + PAGE_GAP;
  const reached = contentBoxes.map(
    (box) => Math.floor((box.y + box.height - 1) / stride) + 1,
  );
  const count = Math.max(1, pageCount, ...reached);
  return Array.from({ length: count }, (_, index) => ({
    index,
    origin: { x: 0, y: pageFrame(index).y },
  }));
}

/**
 * Infinite and fixed canvases have no pages: they are cut into page-sized tiles on a grid
 * anchored at the world origin, keeping only tiles that hold content, in reading order.
 */
export function canvasTiles(contentBoxes: Bounds[]): NotePage[] {
  const tiles = new Map<string, { col: number; row: number }>();
  for (const box of contentBoxes) {
    const right = box.x + Math.max(box.width, 1e-6);
    const bottom = box.y + Math.max(box.height, 1e-6);
    const firstCol = Math.floor(box.x / PAGE_WIDTH);
    const lastCol = Math.ceil(right / PAGE_WIDTH) - 1;
    const firstRow = Math.floor(box.y / PAGE_HEIGHT);
    const lastRow = Math.ceil(bottom / PAGE_HEIGHT) - 1;
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let col = firstCol; col <= lastCol; col += 1) {
        tiles.set(`${col},${row}`, { col, row });
      }
    }
  }
  const sorted = [...tiles.values()].sort(
    (a, b) => a.row - b.row || a.col - b.col,
  );
  if (sorted.length === 0) sorted.push({ col: 0, row: 0 });
  return sorted.map(({ col, row }, index) => ({
    index,
    origin: { x: col * PAGE_WIDTH, y: row * PAGE_HEIGHT },
  }));
}

/** Moves world bounds into a page's coordinates. */
export function toPageBounds(page: NotePage, bounds: Bounds): Bounds {
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    x: round(bounds.x - page.origin.x),
    y: round(bounds.y - page.origin.y),
    width: round(bounds.width),
    height: round(bounds.height),
  };
}

/** The page an object belongs to: the one holding its top-left corner, else the first it overlaps, else the first page. */
export function pageOf(pages: NotePage[], bounds: Bounds): NotePage {
  const corner = { x: bounds.x, y: bounds.y, width: 1, height: 1 };
  return (
    pages.find((page) => boundsIntersect(corner, pageWorldFrame(page))) ??
    pages.find((page) => boundsIntersect(bounds, pageWorldFrame(page))) ??
    pages[0]!
  );
}
