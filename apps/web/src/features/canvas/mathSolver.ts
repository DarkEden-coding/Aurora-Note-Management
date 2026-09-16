import type { Point } from "./viewport";

export type ScreenRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Normalizes and clamps a dragged screen region to the viewport. */
export function normalizeRegion(
  start: Point,
  end: Point,
  width: number,
  height: number,
): ScreenRegion {
  const left = Math.max(0, Math.min(start.x, end.x));
  const top = Math.max(0, Math.min(start.y, end.y));
  const right = Math.min(width, Math.max(start.x, end.x));
  const bottom = Math.min(height, Math.max(start.y, end.y));
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** Expands a selected region around its center without leaving the viewport. */
export function expandResultRegion(
  region: ScreenRegion,
  viewportWidth: number,
  viewportHeight: number,
): ScreenRegion {
  const margin = 12;
  const width = Math.min(
    Math.max(1, viewportWidth - margin * 2),
    Math.max(region.width, 620),
  );
  const height = Math.min(
    Math.max(1, viewportHeight - margin * 2),
    Math.max(region.height, 340),
  );
  return {
    x: Math.max(
      margin,
      Math.min(
        region.x + region.width / 2 - width / 2,
        viewportWidth - width - margin,
      ),
    ),
    y: Math.max(
      margin,
      Math.min(
        region.y + region.height / 2 - height / 2,
        viewportHeight - height - margin,
      ),
    ),
    width,
    height,
  };
}

/** Captures a selected viewport region as a PNG data URL. */
export async function captureMathRegion(
  viewport: HTMLElement,
  region: ScreenRegion,
): Promise<string> {
  const { default: html2canvas } = await import("html2canvas-pro");
  const output = await html2canvas(viewport, {
    backgroundColor: null,
    logging: false,
    scale: 2,
    useCORS: true,
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    ignoreElements: (element) =>
      element.hasAttribute("data-canvas-controls") ||
      element.classList.contains("canvas-math-selection") ||
      element.classList.contains("canvas-math-result"),
  });
  return output.toDataURL("image/png");
}

/** Sends a captured problem to the authenticated Luna math solver. */
export async function solveMathImage(image: string): Promise<string> {
  const response = await fetch("/api/ai/math/solve", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: unknown };
    } | null;
    const message = body?.error?.message;
    throw new Error(
      typeof message === "string"
        ? message
        : `Math solver failed (${response.status})`,
    );
  }
  const body = (await response.json()) as { solution?: unknown };
  if (typeof body.solution !== "string" || !body.solution.trim()) {
    throw new Error("Math solver returned no solution");
  }
  return body.solution;
}
