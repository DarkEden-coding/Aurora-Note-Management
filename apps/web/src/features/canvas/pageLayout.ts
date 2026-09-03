// Canvas mode geometry: page frames per mode, paged vertical stacking, page mapping by y, and mode-specific bounds clamping. Pure math only.
import type { Bounds, CanvasMode, CanvasObject } from "@aurora/shared";
import { boundsContainPoint, translateBounds } from "./viewport";

export const PAGE_WIDTH = 816; // 8.5in at 96dpi
export const PAGE_HEIGHT = 1056; // 11in at 96dpi
export const PAGE_GAP = 24;

export const MAX_OBJECTS_PER_NOTE = 1000;

export const DEMO_OWNER_ID = "00000000-0000-4000-8000-000000000001";

/** Frame of a zero-based page in paged mode (vertical stack anchored at the world origin). */
export function pagedPageFrame(
  index: number,
  pageWidth: number = PAGE_WIDTH,
  pageHeight: number = PAGE_HEIGHT,
  gap: number = PAGE_GAP,
): Bounds {
  return {
    x: 0,
    y: index * (pageHeight + gap),
    width: pageWidth,
    height: pageHeight,
  };
}

/** Zero-based page index containing a paged-mode y coordinate. */
export function pagedPageIndexAtY(
  y: number,
  pageHeight: number = PAGE_HEIGHT,
  gap: number = PAGE_GAP,
): number {
  const stride = pageHeight + gap;
  return y >= 0 ? Math.floor((y + gap) / stride) : 0;
}

/** Minimum page count so paged mode always shows at least one full frame. */
export function pagedPageCount(objects: CanvasObject[]): number {
  let maxBottom = 0;
  for (const o of objects) {
    maxBottom = Math.max(maxBottom, o.bounds.y + o.bounds.height);
  }
  return Math.max(1, pagedPageIndexAtY(maxBottom - 1) + 1);
}

/** Vertical axis fixed (fixed-width mode) or horizontal axis fixed (fixed-height mode); "none" for the other modes. */
export function fixedAxis(mode: CanvasMode): "none" | "x" | "y" {
  switch (mode) {
    case "fixed-width":
      return "x";
    case "fixed-height":
      return "y";
    default:
      return "none";
  }
}

/**
 * Clamps content bounds into the writable region implied by the canvas mode:
 * fixed-width keeps content inside x [0, pageWidth], fixed-height inside y [0, pageHeight],
 * and paged keeps x inside the page width while y stays free.
 */
export function clampBoundsToMode(
  b: Bounds,
  mode: CanvasMode,
  pageWidth: number = PAGE_WIDTH,
  pageHeight: number = PAGE_HEIGHT,
): Bounds {
  switch (mode) {
    case "fixed-width":
    case "paged":
      return clampBoundsToRegion(b, {
        x: 0,
        y: -Infinity,
        width: pageWidth,
        height: Infinity,
      });
    case "fixed-height":
      return clampBoundsToRegion(b, {
        x: -Infinity,
        y: 0,
        width: Infinity,
        height: pageHeight,
      });
    case "infinite":
    default:
      return b;
  }
}

/** Snaps/shifts bounds into a possibly infinite region, anchoring oversized content at the region origin. */
export function clampBoundsToRegion(b: Bounds, region: Bounds): Bounds {
  const x = Number.isFinite(region.width)
    ? b.width >= region.width
      ? region.x
      : Math.max(region.x, Math.min(b.x, region.x + region.width - b.width))
    : b.x;
  const y = Number.isFinite(region.height)
    ? b.height >= region.height
      ? region.y
      : Math.max(region.y, Math.min(b.y, region.y + region.height - b.height))
    : b.y;
  return { ...b, x, y };
}

/** Page frame(s) for the current mode; `null` frames (infinite) yield an empty list. */
export function pageFrames(
  objects: CanvasObject[],
  mode: CanvasMode,
  pageWidth: number = PAGE_WIDTH,
  pageHeight: number = PAGE_HEIGHT,
): Bounds[] {
  switch (mode) {
    case "paged": {
      const count = pagedPageCount(objects);
      return Array.from({ length: count }, (_, i) =>
        pagedPageFrame(i, pageWidth, pageHeight),
      );
    }
    case "fixed-width":
      return [{ x: 0, y: 0, width: pageWidth, height: pageHeight }];
    case "fixed-height":
      return [{ x: 0, y: 0, width: pageWidth, height: pageHeight }];
    case "infinite":
    default:
      return [];
  }
}

/** Maps a canvas point to the page frame containing it, for paged-mode page attribution. */
export function pageFrameAtPoint(
  objects: CanvasObject[],
  mode: CanvasMode,
  p: { x: number; y: number },
): Bounds | null {
  const frames = pageFrames(objects, mode);
  for (const frame of frames) {
    if (boundsContainPoint(frame, p)) return frame;
  }
  return null;
}

/** Attribution helper: the page index a point belongs to in paged mode. */
export function pagedPageIndexOfPoint(p: { x: number; y: number }): number {
  return pagedPageIndexAtY(p.y);
}

/** Moves bounds while keeping them inside the mode's writable region. */
export function translateBoundsInMode(
  b: Bounds,
  dx: number,
  dy: number,
  mode: CanvasMode,
): Bounds {
  return clampBoundsToMode(translateBounds(b, dx, dy), mode);
}
