// Pure viewport coordinate math for the canvas: screen<->canvas conversion, zoom anchors, pan, and visible bounds. No DOM, no React.
import type { Bounds, Viewport } from "@aurora/shared";

export interface Point {
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

export function makeViewport(
  x: number,
  y: number,
  width: number,
  height: number,
  zoom: number,
): Viewport {
  return { x, y, width, height, zoom: clampZoom(zoom) };
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Converts a container-relative screen point into canvas coordinates under the viewport transform. */
export function screenToCanvas(p: Point, v: Viewport): Point {
  return { x: v.x + p.x / v.zoom, y: v.y + p.y / v.zoom };
}

/** Converts a canvas point into container-relative screen coordinates under the viewport transform. */
export function canvasToScreen(p: Point, v: Viewport): Point {
  return { x: (p.x - v.x) * v.zoom, y: (p.y - v.y) * v.zoom };
}

/** The axis-aligned canvas region currently visible inside a container of the given screen size. */
export function visibleCanvasBounds(
  container: { width: number; height: number },
  v: Viewport,
): Bounds {
  return {
    x: v.x,
    y: v.y,
    width: container.width > 0 ? container.width / v.zoom : 0,
    height: container.height > 0 ? container.height / v.zoom : 0,
  };
}

/** Pans the viewport by a screen-space delta (positive deltas move the world with the pointer). */
export function panViewport(
  v: Viewport,
  dxScreen: number,
  dyScreen: number,
): Viewport {
  return { ...v, x: v.x - dxScreen / v.zoom, y: v.y - dyScreen / v.zoom };
}

/** Zooms while keeping the canvas point under the container-relative screen anchor visually fixed. */
export function zoomViewportAround(
  v: Viewport,
  anchorScreen: Point,
  nextZoom: number,
  container: { width: number; height: number },
): Viewport {
  const zoom = clampZoom(nextZoom);
  const anchorCanvas = screenToCanvas(anchorScreen, { ...v, zoom: v.zoom });
  const bounds = visibleCanvasBounds(container, { ...v, zoom });
  return {
    x: anchorCanvas.x - anchorScreen.x / zoom,
    y: anchorCanvas.y - anchorScreen.y / zoom,
    width: bounds.width,
    height: bounds.height,
    zoom,
  };
}

export function expandBounds(b: Bounds, margin: number): Bounds {
  return {
    x: b.x - margin,
    y: b.y - margin,
    width: b.width + margin * 2,
    height: b.height + margin * 2,
  };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export function boundsContainPoint(b: Bounds, p: Point): boolean {
  return (
    p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
  );
}

export function translateBounds(b: Bounds, dx: number, dy: number): Bounds {
  return { ...b, x: b.x + dx, y: b.y + dy };
}

export function unionBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of list) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
