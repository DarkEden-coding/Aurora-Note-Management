// Renders one page (user ink, shapes, typed text, practice cards, marks, coordinate grid) to SVG and rasterizes it to PNG for Claude.
import { renderAsync } from "@resvg/resvg-js";
import type { Bounds, CanvasObject, PracticeCardRegion } from "@aurora/shared";
import { objectText } from "../canvas/text.js";
import { MARK_COLOR, practiceTagOf } from "./marks.js";
import { PAGE_HEIGHT, PAGE_WIDTH, boundsIntersect, pageFrame } from "./page.js";

export const RENDER_SCALE = 1.5;
const REGION_COLOR = "#2f6fd6";
const FADED_OPACITY = 0.35;
// resvg maps the generic "sans-serif" to Arial, which the Linux image lacks; name DejaVu (installed there) first.
const FONT = `font-family="DejaVu Sans, Arial, sans-serif"`;

export type RenderTarget = {
  pageIndex: number;
  // Marks from attempts before this one are drawn faded (a retry in progress).
  attempt: number;
  // World frame of the page; defaults to the paged-note frame of pageIndex (canvas notes pass a tile).
  frame?: Bounds;
  // Data URIs for image and PDF-page objects by object id; objects without one are drawn as boxes.
  rasters?: Map<string, string>;
  // Card elements the browser measured, already moved to page coordinates; drawn on the grey question card.
  regions?: PracticeCardRegion[];
};

export type RenderView = {
  // Page-relative area to draw; the whole page when omitted.
  view?: Bounds;
  scale?: number;
};

const r = (n: number): number => Math.round(n * 10) / 10;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex =
    match[1]!.length === 3
      ? [...match[1]!].map((c) => c + c).join("")
      : match[1]!;
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** Keeps user ink readable on the white render: light colours (dark-theme inks) are darkened. */
export function inkColor(color: unknown): string {
  const rgb = typeof color === "string" ? parseHex(color) : null;
  if (!rgb) return "#222222";
  const linear = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  if (luminance <= 0.45) return color as string;
  return `#${rgb
    .map((c) =>
      Math.round(c * 0.3)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function point(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

// Pressure is bucketed so a stroke becomes a handful of paths, not one per segment.
function strokeSvg(object: CanvasObject, color: string): string {
  const raw = Array.isArray(object.payload.points) ? object.payload.points : [];
  const pts = raw.filter(
    (p): p is [number, number, number] =>
      Array.isArray(p) &&
      p.length >= 3 &&
      p.every((v) => typeof v === "number"),
  );
  const base = num(object.payload.baseWidth, 2.5);
  if (pts.length === 1) {
    const [x, y, p] = pts[0]!;
    return `<circle cx="${r(x)}" cy="${r(y)}" r="${r(Math.max(0.5, base * (0.3 + p)) / 2)}" fill="${color}"/>`;
  }
  const groups = new Map<number, string[]>();
  for (let i = 1; i < pts.length; i += 1) {
    const [ax, ay, ap] = pts[i - 1]!;
    const [bx, by] = pts[i]!;
    const level = Math.round(Math.max(0, Math.min(1, ap)) * 8);
    const segments = groups.get(level) ?? [];
    segments.push(`M${r(ax)} ${r(ay)}L${r(bx)} ${r(by)}`);
    groups.set(level, segments);
  }
  return [...groups]
    .map(
      ([level, segments]) =>
        `<path d="${segments.join("")}" stroke="${color}" stroke-width="${r(Math.max(0.5, base * (0.3 + level / 8)))}" stroke-linecap="round" fill="none"/>`,
    )
    .join("");
}

function shapeSvg(object: CanvasObject, color: string): string {
  const b = object.bounds;
  const width = num(object.payload.strokeWidth, 2);
  const fill =
    typeof object.payload.fill === "string"
      ? inkColor(object.payload.fill)
      : "none";
  const fillOpacity =
    typeof object.payload.fillOpacity === "number"
      ? object.payload.fillOpacity / 100
      : 1;
  const style = `stroke="${color}" stroke-width="${width}" fill="${fill}" fill-opacity="${fillOpacity}"`;
  if (object.kind === "rectangle") {
    return `<rect x="${r(b.x)}" y="${r(b.y)}" width="${r(b.width)}" height="${r(b.height)}" ${style}/>`;
  }
  return `<ellipse cx="${r(b.x + b.width / 2)}" cy="${r(b.y + b.height / 2)}" rx="${r(b.width / 2)}" ry="${r(b.height / 2)}" ${style}/>`;
}

function lineSvg(object: CanvasObject, color: string): string {
  const b = object.bounds;
  const start = point(object.payload.start) ?? { x: b.x, y: b.y };
  const end = point(object.payload.end) ?? {
    x: b.x + b.width,
    y: b.y + b.height,
  };
  const width = num(object.payload.strokeWidth, 2);
  let svg = `<line x1="${r(start.x)}" y1="${r(start.y)}" x2="${r(end.x)}" y2="${r(end.y)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
  if (object.kind === "arrow") {
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const head = Math.min(18, Math.max(8, length / 4));
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const wing = (spread: number): string =>
      `${r(end.x - head * Math.cos(angle + spread))},${r(end.y - head * Math.sin(angle + spread))}`;
    svg += `<polygon points="${r(end.x)},${r(end.y)} ${wing(-Math.PI / 7)} ${wing(Math.PI / 7)}" fill="${color}"/>`;
  }
  return svg;
}

function labelledBox(
  object: CanvasObject,
  label: string,
  fill: string,
  stroke: string,
  corner = false,
): string {
  const b = object.bounds;
  const text = corner
    ? `<text x="${r(b.x + b.width - 8)}" y="${r(b.y + 16)}" ${FONT} font-size="12" fill="#6b7280" text-anchor="end">${escapeXml(label)}</text>`
    : `<text x="${r(b.x + b.width / 2)}" y="${r(b.y + Math.min(b.height / 2, 40) + 7)}" ${FONT} font-size="20" fill="#6b7280" text-anchor="middle">${escapeXml(label)}</text>`;
  return (
    `<rect x="${r(b.x)}" y="${r(b.y)}" width="${r(b.width)}" height="${r(b.height)}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="2"/>` +
    text
  );
}

// Each measured card element: a dashed blue outline, its label, and its text when it fits.
function regionsSvg(regions: PracticeCardRegion[], frame: Bounds): string {
  return regions
    .map((region) => {
      const x = region.x + frame.x;
      const y = region.y + frame.y;
      const name =
        region.kind === "option"
          ? region.label
          : region.kind === "finalAnswer"
            ? "final answer"
            : region.label;
      const chars = Math.max(0, Math.floor((region.width - 34) / 6.5));
      const text =
        region.text && chars > 3 && region.kind !== "finalAnswer"
          ? region.text.length > chars
            ? `${region.text.slice(0, chars - 1)}…`
            : region.text
          : "";
      return (
        `<rect x="${r(x)}" y="${r(y)}" width="${r(region.width)}" height="${r(region.height)}" rx="4" fill="none" stroke="${REGION_COLOR}" stroke-width="1.5" stroke-dasharray="5 3"/>` +
        `<text x="${r(x + 4)}" y="${r(y + 14)}" ${FONT} font-size="13" font-weight="bold" fill="${REGION_COLOR}">${escapeXml(name)}</text>` +
        (text
          ? `<text x="${r(x + 4 + name.length * 9 + 6)}" y="${r(y + 14)}" ${FONT} font-size="11" fill="#4b5563">${escapeXml(text)}</text>`
          : "")
      );
    })
    .join("");
}

// Wraps plain text roughly by character count; enough for Claude to read typed text and red labels.
function textBlockSvg(
  b: Bounds,
  text: string,
  color: string,
  fontSize: number,
): string {
  const lineHeight = Math.round(fontSize * 1.4);
  const perLine = Math.max(1, Math.floor(b.width / (fontSize / 2)));
  const lines = text
    .split("\n")
    .flatMap((line) => line.match(new RegExp(`.{1,${perLine}}`, "g")) ?? [""]);
  return lines
    .map(
      (line, i) =>
        `<text x="${r(b.x)}" y="${r(b.y + fontSize + 2 + i * lineHeight)}" ${FONT} font-size="${fontSize}" fill="${color}">${escapeXml(line)}</text>`,
    )
    .join("");
}

const CARD_LABELS: Record<string, string> = {
  prompt: "Question card",
  feedback: "Feedback card",
  solution: "Solution card",
  summary: "Summary card",
};

function objectSvg(object: CanvasObject, target: RenderTarget): string {
  const tag = practiceTagOf(object);
  const faded =
    tag !== null && tag.role !== "prompt" && tag.attempt < target.attempt;
  const color = tag ? MARK_COLOR : inkColor(object.payload.color);
  let svg: string;
  const raster = target.rasters?.get(object.id);
  if (raster) {
    const b = object.bounds;
    return `<image href="${raster}" x="${r(b.x)}" y="${r(b.y)}" width="${r(b.width)}" height="${r(b.height)}" preserveAspectRatio="none"/>`;
  }
  switch (object.kind) {
    case "stroke":
      svg = strokeSvg(object, color);
      break;
    case "rectangle":
    case "ellipse":
      svg = shapeSvg(object, color);
      break;
    case "line":
    case "arrow":
      svg = lineSvg(object, color);
      break;
    case "practice-card": {
      const variant = String(object.payload.variant ?? "");
      svg =
        variant === "label"
          ? textBlockSvg(
              object.bounds,
              objectText(object) ?? "",
              MARK_COLOR,
              20,
            )
          : variant === "prompt"
            ? labelledBox(
                object,
                "Question card",
                "#e5e7eb",
                "#9ca3af",
                (target.regions?.length ?? 0) > 0,
              )
            : labelledBox(
                object,
                CARD_LABELS[variant] ?? "Card",
                "none",
                "#f0a8a8",
              );
      break;
    }
    case "rich-text":
      svg = textBlockSvg(object.bounds, objectText(object) ?? "", color, 16);
      break;
    case "sticky-note":
      svg =
        `<rect x="${r(object.bounds.x)}" y="${r(object.bounds.y)}" width="${r(object.bounds.width)}" height="${r(object.bounds.height)}" rx="6" fill="#fdf3c4" stroke="#e5c85a"/>` +
        textBlockSvg(
          {
            ...object.bounds,
            x: object.bounds.x + 10,
            width: object.bounds.width - 20,
          },
          objectText(object) ?? "",
          "#222222",
          14,
        );
      break;
    default:
      svg = labelledBox(object, object.kind, "#f5f5f5", "#c4c8ce");
  }
  return faded ? `<g opacity="${FADED_OPACITY}">${svg}</g>` : svg;
}

// Labels sit on the view's top and left edges, so a cropped image still reads in page units;
// they are drawn last, with a white halo, so cards and ink never hide them.
function gridSvg(view: Bounds): { lines: string; labels: string } {
  const minor: string[] = [];
  const major: string[] = [];
  const labels: string[] = [];
  const right = view.x + view.width;
  const bottom = view.y + view.height;
  for (let x = 50; x < PAGE_WIDTH; x += 50) {
    (x % 100 === 0 ? major : minor).push(`M${x} 0V${PAGE_HEIGHT}`);
    if (x % 100 === 0 && x > view.x && x < right - 24) {
      labels.push(`<text x="${x + 2}" y="${view.y + 10}">${x}</text>`);
    }
  }
  for (let y = 50; y < PAGE_HEIGHT; y += 50) {
    (y % 100 === 0 ? major : minor).push(`M0 ${y}H${PAGE_WIDTH}`);
    if (y % 100 === 0 && y > view.y + 12 && y <= bottom) {
      labels.push(`<text x="${view.x + 2}" y="${y - 2}">${y}</text>`);
    }
  }
  return {
    lines:
      `<path d="${minor.join("")}" stroke="#f0f1f3" stroke-width="1"/>` +
      `<path d="${major.join("")}" stroke="#dfe2e6" stroke-width="1"/>`,
    labels: `<g ${FONT} font-size="10" fill="#8a909a" stroke="#ffffff" stroke-width="3" paint-order="stroke">${labels.join("")}</g>`,
  };
}

const FULL_PAGE: Bounds = {
  x: 0,
  y: 0,
  width: PAGE_WIDTH,
  height: PAGE_HEIGHT,
};

/**
 * SVG of one page (or the `view` part of it) in page-relative units; only objects intersecting
 * the page are drawn. Measured card regions go above the question card and below the user's ink.
 */
export function buildPageSvg(
  objects: CanvasObject[],
  target: RenderTarget,
  view: Bounds = FULL_PAGE,
): string {
  const frame = target.frame ?? pageFrame(target.pageIndex);
  const onPage = objects
    .filter((object) => boundsIntersect(object.bounds, frame))
    .sort((a, b) => a.zIndex - b.zIndex);
  // The opaque question card goes first so ink written on it (a circled option) stays visible.
  const prompts = onPage.filter((o) => practiceTagOf(o)?.role === "prompt");
  const rest = onPage.filter((o) => !prompts.includes(o));
  const draw = (list: CanvasObject[]): string =>
    list.map((o) => objectSvg(o, target)).join("");
  const grid = gridSvg(view);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${r(view.width)}" height="${r(view.height)}" viewBox="${r(view.x)} ${r(view.y)} ${r(view.width)} ${r(view.height)}">` +
    `<rect width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" fill="#ffffff"/>` +
    grid.lines +
    `<g transform="translate(${-frame.x} ${-frame.y})">${draw(prompts)}${regionsSvg(target.regions ?? [], frame)}${draw(rest)}</g>` +
    grid.labels +
    `</svg>`
  );
}

/** Rasterizes the page (default 1.5x). Missing system fonts only drop text; boxes and ink still render. */
export async function renderPagePng(
  objects: CanvasObject[],
  target: RenderTarget,
  { view, scale = RENDER_SCALE }: RenderView = {},
): Promise<Buffer> {
  const image = await renderAsync(buildPageSvg(objects, target, view), {
    fitTo: { mode: "zoom", value: scale },
    // resvg's own system scan misses Debian's font folder, so name it (absent elsewhere, then ignored).
    font: { loadSystemFonts: true, fontDirs: ["/usr/share/fonts"] },
    logLevel: "off",
  });
  return image.asPng();
}
