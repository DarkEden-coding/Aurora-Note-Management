// Converts Claude's page-relative grading marks and practice cards into locked, world-positioned canvas objects.
import crypto from "node:crypto";
import { z } from "zod";
import {
  hexColorSchema,
  textStyleSchema,
  type Bounds,
  type CanvasObject,
  type TextStyle,
} from "@aurora/shared";
import { PAGE_HEIGHT, PAGE_WIDTH, pageFrame } from "./page.js";
import { wrapText } from "./textLayout.js";

export const MARK_COLOR = "#ff5c5c";
const MARK_WIDTH = 3;
// Practice objects stay above the user's handwriting.
const PRACTICE_Z_INDEX = 100_000;

// info: a reference card (e.g. an equation sheet) that is not a question.
export type PracticeRole =
  "prompt" | "mark" | "label" | "feedback" | "solution" | "summary" | "info";

// html: a free-form HTML block (agent inserts in any note, practice reference cards).
export type CardVariant =
  "prompt" | "feedback" | "solution" | "label" | "summary" | "html";

export type PracticeTag = {
  questionId: string | null;
  attempt: number;
  role: PracticeRole;
};

const px = z.number().min(0).max(PAGE_WIDTH);
const py = z.number().min(0).max(PAGE_HEIGHT);

// Optional look of a drawn mark; defaults to red, 3 units wide.
export const markStyleShape = {
  color: hexColorSchema.optional().describe("Hex color, default #ff5c5c"),
  strokeWidth: z
    .number()
    .min(0.5)
    .max(40)
    .optional()
    .describe("Line width in page units, default 3"),
};
type MarkStyle = {
  color?: string | undefined;
  strokeWidth?: number | undefined;
};

export const markSchema = z.union([
  z
    .object({
      type: z.enum(["circle", "box"]),
      x: px.describe("Left edge"),
      y: py.describe("Top edge"),
      width: z.number().positive().max(PAGE_WIDTH),
      height: z.number().positive().max(PAGE_HEIGHT),
      ...markStyleShape,
    })
    .describe("Ellipse (circle) or rectangle (box) around a region"),
  z
    .object({
      type: z.enum(["underline", "strike", "arrow"]),
      x1: px,
      y1: py,
      x2: px,
      y2: py,
      ...markStyleShape,
    })
    .describe("Straight line; arrow points from (x1,y1) to (x2,y2)"),
  z
    .object({
      type: z.enum(["check", "cross"]),
      x: px.describe("Center x"),
      y: py.describe("Center y"),
      size: z.number().positive().max(200).default(28),
      ...markStyleShape,
    })
    .describe("Tick or X centred on (x,y)"),
  z
    .object({
      type: z.literal("path"),
      points: z
        .array(z.tuple([px, py]))
        .min(2)
        .max(2000),
      ...markStyleShape,
    })
    .describe("Freehand polyline through [x,y] points"),
  z
    .object({
      type: z.literal("text"),
      x: px.describe("Left edge"),
      y: py.describe("Top edge"),
      text: z.string().min(1).max(500),
      width: z.number().positive().max(PAGE_WIDTH).optional(),
      ...textStyleSchema.shape,
    })
    .describe(
      "Short comment; wraps at width (default 220). Red 20px sans-serif unless fontFamily, fontSize, fontWeight, fontStyle or color say otherwise",
    ),
]);

export type Mark = z.infer<typeof markSchema>;

type Point = { x: number; y: number };

export type ObjectContext = {
  ownerId: string;
  noteId: string;
  pageIndex: number;
  // World position of the page's top-left; defaults to the paged-note frame of pageIndex.
  origin?: Point;
};

function pageOrigin(ctx: ObjectContext): Point {
  return ctx.origin ?? { x: 0, y: pageFrame(ctx.pageIndex).y };
}

function toWorld(ctx: ObjectContext, bounds: Bounds): Bounds {
  const origin = pageOrigin(ctx);
  return { ...bounds, x: bounds.x + origin.x, y: bounds.y + origin.y };
}

/** Builds one locked practice object from world bounds. */
export function practiceObject(
  ctx: ObjectContext,
  kind: CanvasObject["kind"],
  worldBounds: Bounds,
  payload: Record<string, unknown>,
  practice: PracticeTag,
): CanvasObject {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: ctx.ownerId,
    noteId: ctx.noteId,
    pageId: null,
    kind,
    bounds: worldBounds,
    rotation: 0,
    zIndex: PRACTICE_Z_INDEX,
    locked: true,
    groupId: null,
    payload: { ...payload, practice },
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** A practice-card (prompt, feedback, solution, summary, label) placed in page-relative bounds. */
export function cardObject(
  ctx: ObjectContext,
  variant: CardVariant,
  html: string,
  pageBounds: Bounds,
  practice: PracticeTag,
  style: TextStyle = {},
): CanvasObject {
  return practiceObject(
    ctx,
    "practice-card",
    toWorld(ctx, pageBounds),
    { variant, html, ...style },
    practice,
  );
}

function boundsAround(points: Point[], pad: number): Bounds {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  return {
    x: minX,
    y: minY,
    width: Math.max(1, Math.max(...xs) + pad - minX),
    height: Math.max(1, Math.max(...ys) + pad - minY),
  };
}

/** Label card HTML for plain text (one line per line). */
export function labelHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const LABEL_FONT_SIZE = 20;

/** Height of a label card: its text wrapped like the app (20px, line-height 1.25) plus a little room. */
export function labelHeight(
  text: string,
  width: number,
  style: TextStyle = {},
): number {
  const fontSize = style.fontSize ?? LABEL_FONT_SIZE;
  const lines = wrapText(
    text,
    width,
    { fontFamily: "sans", ...style },
    fontSize,
  );
  return Math.ceil(lines.length * fontSize * 1.25 + 8);
}

function strokeObject(
  ctx: ObjectContext,
  pagePoints: Point[],
  practice: PracticeTag,
  style: MarkStyle,
): CanvasObject {
  const width = style.strokeWidth ?? MARK_WIDTH;
  const origin = pageOrigin(ctx);
  const world = pagePoints.map((p) => ({
    x: p.x + origin.x,
    y: p.y + origin.y,
  }));
  return practiceObject(
    ctx,
    "stroke",
    boundsAround(world, width),
    {
      points: world.map((p) => [p.x, p.y, 0.5]),
      color: style.color ?? MARK_COLOR,
      baseWidth: width,
    },
    practice,
  );
}

function lineObject(
  ctx: ObjectContext,
  kind: "line" | "arrow",
  start: Point,
  end: Point,
  practice: PracticeTag,
  style: MarkStyle,
): CanvasObject {
  const width = style.strokeWidth ?? MARK_WIDTH;
  const origin = pageOrigin(ctx);
  const s = { x: start.x + origin.x, y: start.y + origin.y };
  const e = { x: end.x + origin.x, y: end.y + origin.y };
  return practiceObject(
    ctx,
    kind,
    boundsAround([s, e], width),
    {
      start: s,
      end: e,
      color: style.color ?? MARK_COLOR,
      strokeWidth: width,
      lineStyle: "solid",
    },
    practice,
  );
}

/** Converts one page-relative mark into canvas objects (a cross becomes two strokes). */
export function markToObjects(
  ctx: ObjectContext,
  mark: Mark,
  questionId: string | null,
  attempt: number,
): CanvasObject[] {
  const tag: PracticeTag = { questionId, attempt, role: "mark" };
  switch (mark.type) {
    case "circle":
    case "box":
      return [
        practiceObject(
          ctx,
          mark.type === "circle" ? "ellipse" : "rectangle",
          toWorld(ctx, {
            x: mark.x,
            y: mark.y,
            width: mark.width,
            height: mark.height,
          }),
          {
            color: mark.color ?? MARK_COLOR,
            fill: null,
            fillOpacity: 100,
            strokeWidth: mark.strokeWidth ?? MARK_WIDTH,
            lineStyle: "solid",
          },
          tag,
        ),
      ];
    case "underline":
    case "strike":
    case "arrow":
      return [
        lineObject(
          ctx,
          mark.type === "arrow" ? "arrow" : "line",
          { x: mark.x1, y: mark.y1 },
          { x: mark.x2, y: mark.y2 },
          tag,
          mark,
        ),
      ];
    case "check": {
      const s = mark.size;
      return [
        strokeObject(
          ctx,
          [
            { x: mark.x - 0.5 * s, y: mark.y },
            { x: mark.x - 0.15 * s, y: mark.y + 0.4 * s },
            { x: mark.x + 0.5 * s, y: mark.y - 0.45 * s },
          ],
          tag,
          mark,
        ),
      ];
    }
    case "cross": {
      const h = 0.4 * mark.size;
      return [
        strokeObject(
          ctx,
          [
            { x: mark.x - h, y: mark.y - h },
            { x: mark.x + h, y: mark.y + h },
          ],
          tag,
          mark,
        ),
        strokeObject(
          ctx,
          [
            { x: mark.x + h, y: mark.y - h },
            { x: mark.x - h, y: mark.y + h },
          ],
          tag,
          mark,
        ),
      ];
    }
    case "path":
      return [
        strokeObject(
          ctx,
          mark.points.map(([x, y]) => ({ x, y })),
          tag,
          mark,
        ),
      ];
    case "text": {
      const width = mark.width ?? 220;
      const { type, x, y, text, width: _width, ...style } = mark;
      return [
        cardObject(
          ctx,
          "label",
          labelHtml(text),
          { x, y, width, height: labelHeight(text, width, style) },
          { questionId, attempt, role: "label" },
          // Agent comments read in a plain sans-serif unless asked otherwise.
          { fontFamily: "sans", ...style },
        ),
      ];
    }
  }
}

/** Reads the practice tag the server stored on a practice object, if any. */
export function practiceTagOf(object: CanvasObject): PracticeTag | null {
  const tag = object.payload.practice;
  if (!tag || typeof tag !== "object") return null;
  const { questionId, attempt, role } = tag as Record<string, unknown>;
  if (typeof attempt !== "number" || typeof role !== "string") return null;
  return {
    questionId: typeof questionId === "string" ? questionId : null,
    attempt,
    role: role as PracticeRole,
  };
}
