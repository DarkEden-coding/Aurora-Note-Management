// Renders one practice page (user ink, shapes, practice cards, marks, coordinate grid) to SVG and rasterizes it to PNG for Claude.
import { renderAsync } from "@resvg/resvg-js";
import type { CanvasObject } from "@aurora/shared";
import { MARK_COLOR, practiceTagOf } from "./marks.js";
import { PAGE_HEIGHT, PAGE_WIDTH, boundsIntersect, pageFrame } from "./page.js";

const RENDER_SCALE = 1.5;
const FADED_OPACITY = 0.35;
const FONT = 'font-family="sans-serif"';

export type RenderTarget = {
  pageIndex: number;
  // Marks from attempts before this one are drawn faded (a retry in progress).
  attempt: number;
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
): string {
  const b = object.bounds;
  return (
    `<rect x="${r(b.x)}" y="${r(b.y)}" width="${r(b.width)}" height="${r(b.height)}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="2"/>` +
    `<text x="${r(b.x + b.width / 2)}" y="${r(b.y + Math.min(b.height / 2, 40) + 7)}" ${FONT} font-size="20" fill="#6b7280" text-anchor="middle">${escapeXml(label)}</text>`
  );
}

// Labels are stored as escaped text with <br>; recover the plain text and wrap it roughly.
function labelSvg(object: CanvasObject, color: string): string {
  const html =
    typeof object.payload.html === "string" ? object.payload.html : "";
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  const perLine = Math.max(1, Math.floor(object.bounds.width / 10));
  const lines = text
    .split("\n")
    .flatMap((line) => line.match(new RegExp(`.{1,${perLine}}`, "g")) ?? [""]);
  const b = object.bounds;
  return lines
    .map(
      (line, i) =>
        `<text x="${r(b.x)}" y="${r(b.y + 22 + i * 28)}" ${FONT} font-size="20" fill="${color}">${escapeXml(line)}</text>`,
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
          ? labelSvg(object, MARK_COLOR)
          : variant === "prompt"
            ? labelledBox(object, "Question card", "#e5e7eb", "#9ca3af")
            : labelledBox(
                object,
                CARD_LABELS[variant] ?? "Card",
                "none",
                "#f0a8a8",
              );
      break;
    }
    default:
      svg = labelledBox(object, object.kind, "#f5f5f5", "#c4c8ce");
  }
  return faded ? `<g opacity="${FADED_OPACITY}">${svg}</g>` : svg;
}

function gridSvg(): string {
  const minor: string[] = [];
  const major: string[] = [];
  const labels: string[] = [];
  for (let x = 50; x < PAGE_WIDTH; x += 50) {
    (x % 100 === 0 ? major : minor).push(`M${x} 0V${PAGE_HEIGHT}`);
    if (x % 100 === 0 && x < PAGE_WIDTH - 24) {
      labels.push(`<text x="${x + 2}" y="10">${x}</text>`);
    }
  }
  for (let y = 50; y < PAGE_HEIGHT; y += 50) {
    (y % 100 === 0 ? major : minor).push(`M0 ${y}H${PAGE_WIDTH}`);
    if (y % 100 === 0) {
      labels.push(`<text x="2" y="${y - 2}">${y}</text>`);
    }
  }
  return (
    `<path d="${minor.join("")}" stroke="#f0f1f3" stroke-width="1"/>` +
    `<path d="${major.join("")}" stroke="#dfe2e6" stroke-width="1"/>` +
    `<g ${FONT} font-size="10" fill="#a0a6b0">${labels.join("")}</g>`
  );
}

/** SVG of one page in page-relative units; only objects intersecting the page are drawn. */
export function buildPageSvg(
  objects: CanvasObject[],
  target: RenderTarget,
): string {
  const frame = pageFrame(target.pageIndex);
  const onPage = objects
    .filter((object) => boundsIntersect(object.bounds, frame))
    .sort((a, b) => a.zIndex - b.zIndex);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">` +
    `<rect width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" fill="#ffffff"/>` +
    gridSvg() +
    `<g transform="translate(0 ${-frame.y})">${onPage.map((o) => objectSvg(o, target)).join("")}</g>` +
    `</svg>`
  );
}

/** Rasterizes the page at 1.5x. Missing system fonts only drop text; boxes and ink still render. */
export async function renderPagePng(
  objects: CanvasObject[],
  target: RenderTarget,
): Promise<Buffer> {
  const image = await renderAsync(buildPageSvg(objects, target), {
    fitTo: { mode: "zoom", value: RENDER_SCALE },
    font: { loadSystemFonts: true },
    logLevel: "off",
  });
  return image.asPng();
}
