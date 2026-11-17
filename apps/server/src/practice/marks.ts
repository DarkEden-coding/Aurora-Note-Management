// Converts Claude's page-relative grading marks and practice cards into locked, world-positioned canvas objects.
import crypto from "node:crypto";
import { z } from "zod";
import type { Bounds, CanvasObject } from "@aurora/shared";
import {
  PAGE_HEIGHT,
  PAGE_WIDTH,
  pageBoundsToWorld,
  pageFrame,
} from "./page.js";

export const MARK_COLOR = "#ff5c5c";
const MARK_WIDTH = 3;
// Practice objects stay above the user's handwriting.
const PRACTICE_Z_INDEX = 100_000;

export type PracticeRole =
  "prompt" | "mark" | "label" | "feedback" | "solution" | "summary";

export type CardVariant =
  "prompt" | "feedback" | "solution" | "label" | "summary";

export type PracticeTag = {
  questionId: string | null;
  attempt: number;
  role: PracticeRole;
};

const px = z.number().min(0).max(PAGE_WIDTH);
const py = z.number().min(0).max(PAGE_HEIGHT);

export const markSchema = z.union([
  z
    .object({
      type: z.enum(["circle", "box"]),
      x: px.describe("Left edge"),
      y: py.describe("Top edge"),
      width: z.number().positive().max(PAGE_WIDTH),
      height: z.number().positive().max(PAGE_HEIGHT),
    })
    .describe("Ellipse (circle) or rectangle (box) around a region"),
  z
    .object({
      type: z.enum(["underline", "strike", "arrow"]),
      x1: px,
      y1: py,
      x2: px,
      y2: py,
    })
    .describe("Straight line; arrow points from (x1,y1) to (x2,y2)"),
  z
    .object({
      type: z.enum(["check", "cross"]),
      x: px.describe("Center x"),
      y: py.describe("Center y"),
      size: z.number().positive().max(200).default(28),
    })
    .describe("Tick or X centred on (x,y)"),
  z
    .object({
      type: z.literal("path"),
      points: z
        .array(z.tuple([px, py]))
        .min(2)
        .max(2000),
    })
    .describe("Freehand polyline through [x,y] points"),
  z
    .object({
      type: z.literal("text"),
      x: px.describe("Left edge"),
      y: py.describe("Top edge"),
      text: z.string().min(1).max(500),
      width: z.number().positive().max(PAGE_WIDTH).optional(),
    })
    .describe("Short red handwritten-style note; wraps at width (default 220)"),
]);

export type Mark = z.infer<typeof markSchema>;

export type ObjectContext = {
  ownerId: string;
  noteId: string;
  pageIndex: number;
};

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
): CanvasObject {
  return practiceObject(
    ctx,
    "practice-card",
    pageBoundsToWorld(ctx.pageIndex, pageBounds),
    { variant, html },
    practice,
  );
}

type Point = { x: number; y: number };

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Rough handwriting-label metrics, enough to give the card a sensible height.
const LABEL_CHAR_WIDTH = 10;
const LABEL_LINE_HEIGHT = 28;

function labelHeight(text: string, width: number): number {
  const perLine = Math.max(1, Math.floor(width / LABEL_CHAR_WIDTH));
  const lines = text
    .split("\n")
    .reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)),
      0,
    );
  return lines * LABEL_LINE_HEIGHT + 8;
}

function strokeObject(
  ctx: ObjectContext,
  pagePoints: Point[],
  practice: PracticeTag,
): CanvasObject {
  const offsetY = pageFrame(ctx.pageIndex).y;
  const world = pagePoints.map((p) => ({ x: p.x, y: p.y + offsetY }));
  return practiceObject(
    ctx,
    "stroke",
    boundsAround(world, MARK_WIDTH),
    {
      points: world.map((p) => [p.x, p.y, 0.5]),
      color: MARK_COLOR,
      baseWidth: MARK_WIDTH,
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
): CanvasObject {
  const offsetY = pageFrame(ctx.pageIndex).y;
  const s = { x: start.x, y: start.y + offsetY };
  const e = { x: end.x, y: end.y + offsetY };
  return practiceObject(
    ctx,
    kind,
    boundsAround([s, e], MARK_WIDTH),
    {
      start: s,
      end: e,
      color: MARK_COLOR,
      strokeWidth: MARK_WIDTH,
      lineStyle: "solid",
    },
    practice,
  );
}

/** Converts one page-relative mark into canvas objects (a cross becomes two strokes). */
export function markToObjects(
  ctx: ObjectContext,
  mark: Mark,
  questionId: string,
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
          pageBoundsToWorld(ctx.pageIndex, {
            x: mark.x,
            y: mark.y,
            width: mark.width,
            height: mark.height,
          }),
          {
            color: MARK_COLOR,
            fill: null,
            fillOpacity: 100,
            strokeWidth: MARK_WIDTH,
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
        ),
        strokeObject(
          ctx,
          [
            { x: mark.x + h, y: mark.y - h },
            { x: mark.x - h, y: mark.y + h },
          ],
          tag,
        ),
      ];
    }
    case "path":
      return [
        strokeObject(
          ctx,
          mark.points.map(([x, y]) => ({ x, y })),
          tag,
        ),
      ];
    case "text": {
      const width = mark.width ?? 220;
      return [
        cardObject(
          ctx,
          "label",
          escapeHtml(mark.text).replace(/\n/g, "<br>"),
          {
            x: mark.x,
            y: mark.y,
            width,
            height: labelHeight(mark.text, width),
          },
          { questionId, attempt, role: "label" },
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
