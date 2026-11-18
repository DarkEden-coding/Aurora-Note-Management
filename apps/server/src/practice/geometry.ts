// Page geometry Claude gets with a submission: the user's ink bounds and clusters, free space for feedback, and crop views.
import type { Bounds } from "@aurora/shared";
import { PAGE_HEIGHT, PAGE_WIDTH } from "./page.js";

// Strokes closer than this join one cluster (about a handwriting line gap).
const CLUSTER_GAP = 24;
const MAX_CLUSTERS = 20;

// Free regions are found on a coarse grid of cells, away from ink and the page edge.
const CELL = 16;
const INK_CLEARANCE = 12;
const PAGE_MARGIN = 16;
const MIN_FREE_WIDTH = 8 * CELL;
const MIN_FREE_HEIGHT = 3 * CELL;
const MAX_FREE_HEIGHT = 10 * CELL;
const MAX_FREE_REGIONS = 6;

export function unionBounds(boxes: Bounds[]): Bounds | null {
  if (boxes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of boxes) {
    left = Math.min(left, b.x);
    top = Math.min(top, b.y);
    right = Math.max(right, b.x + b.width);
    bottom = Math.max(bottom, b.y + b.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Grows `b` by `by` on every side and clamps it to the page. */
export function padToPage(b: Bounds, by: number): Bounds {
  const left = Math.max(0, b.x - by);
  const top = Math.max(0, b.y - by);
  const right = Math.min(PAGE_WIDTH, b.x + b.width + by);
  const bottom = Math.min(PAGE_HEIGHT, b.y + b.height + by);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Snaps outward to the 50-unit grid so a cropped image starts and ends on grid lines. */
export function snapToGrid(b: Bounds): Bounds {
  const left = Math.floor(b.x / 50) * 50;
  const top = Math.floor(b.y / 50) * 50;
  const right = Math.min(PAGE_WIDTH, Math.ceil((b.x + b.width) / 50) * 50);
  const bottom = Math.min(PAGE_HEIGHT, Math.ceil((b.y + b.height) / 50) * 50);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function near(a: Bounds, b: Bounds, gap: number): boolean {
  return (
    a.x - gap < b.x + b.width &&
    a.x + a.width + gap > b.x &&
    a.y - gap < b.y + b.height &&
    a.y + a.height + gap > b.y
  );
}

/** Groups nearby ink boxes into clusters (e.g. separate working steps), top to bottom. */
export function inkClusters(boxes: Bounds[]): Bounds[] {
  let clusters = boxes.map((b) => ({ ...b }));
  let merged = true;
  while (merged) {
    merged = false;
    const next: Bounds[] = [];
    for (const box of clusters) {
      const hit = next.findIndex((c) => near(c, box, CLUSTER_GAP));
      if (hit === -1) {
        next.push(box);
      } else {
        next[hit] = unionBounds([next[hit]!, box])!;
        merged = true;
      }
    }
    clusters = next;
  }
  return clusters.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, MAX_CLUSTERS);
}

function distance(a: Bounds, b: Bounds): number {
  const dx = Math.max(0, b.x - (a.x + a.width), a.x - (b.x + b.width));
  const dy = Math.max(0, b.y - (a.y + a.height), a.y - (b.y + b.height));
  return Math.hypot(dx, dy);
}

/**
 * Empty page rectangles big enough for a text mark or feedback card, preferring large
 * ones close to the user's ink. `occupied` is everything already drawn (ink, cards, marks).
 */
export function freeRegions(occupied: Bounds[], ink: Bounds[]): Bounds[] {
  const cols = Math.floor((PAGE_WIDTH - 2 * PAGE_MARGIN) / CELL);
  const rows = Math.floor((PAGE_HEIGHT - 2 * PAGE_MARGIN) / CELL);
  const blocked = Array.from({ length: rows }, () =>
    new Array<boolean>(cols).fill(false),
  );
  const block = (b: Bounds, clearance: number): void => {
    const c0 = Math.floor((b.x - clearance - PAGE_MARGIN) / CELL);
    const c1 = Math.ceil((b.x + b.width + clearance - PAGE_MARGIN) / CELL);
    const r0 = Math.floor((b.y - clearance - PAGE_MARGIN) / CELL);
    const r1 = Math.ceil((b.y + b.height + clearance - PAGE_MARGIN) / CELL);
    for (let r = Math.max(0, r0); r < Math.min(rows, r1); r += 1) {
      for (let c = Math.max(0, c0); c < Math.min(cols, c1); c += 1) {
        blocked[r]![c] = true;
      }
    }
  };
  for (const b of occupied) block(b, INK_CLEARANCE);

  const found: Bounds[] = [];
  while (found.length < MAX_FREE_REGIONS) {
    const best = bestEmptyRectangle(blocked, ink);
    if (!best) break;
    found.push(best);
    block(best, 0);
  }
  return found.sort((a, b) => a.y - b.y || a.x - b.x);
}

// Maximal-rectangle scan (histogram per row) with heights capped, scored by area and closeness to ink.
function bestEmptyRectangle(
  blocked: boolean[][],
  ink: Bounds[],
): Bounds | null {
  const rows = blocked.length;
  const cols = blocked[0]?.length ?? 0;
  const heights = new Array<number>(cols).fill(0);
  let best: { bounds: Bounds; score: number } | null = null;
  const consider = (row: number, left: number, right: number, h: number) => {
    const bounds = {
      x: PAGE_MARGIN + left * CELL,
      y: PAGE_MARGIN + (row - h + 1) * CELL,
      width: (right - left) * CELL,
      height: h * CELL,
    };
    if (bounds.width < MIN_FREE_WIDTH || bounds.height < MIN_FREE_HEIGHT) {
      return;
    }
    const gap =
      ink.length === 0 ? 0 : Math.min(...ink.map((b) => distance(b, bounds)));
    const score = (bounds.width * bounds.height) / (1 + gap / 100);
    if (!best || score > best.score) best = { bounds, score };
  };
  for (let row = 0; row < rows; row += 1) {
    for (let c = 0; c < cols; c += 1) {
      heights[c] = blocked[row]![c]
        ? 0
        : Math.min(heights[c]! + 1, MAX_FREE_HEIGHT / CELL);
    }
    const stack: number[] = [];
    for (let c = 0; c <= cols; c += 1) {
      const h = c === cols ? 0 : heights[c]!;
      while (stack.length > 0 && heights[stack[stack.length - 1]!]! >= h) {
        const top = stack.pop()!;
        const left = stack.length === 0 ? 0 : stack[stack.length - 1]! + 1;
        if (heights[top]! > 0) consider(row, left, c, heights[top]!);
      }
      stack.push(c);
    }
  }
  return (best as { bounds: Bounds } | null)?.bounds ?? null;
}
