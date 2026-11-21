// The agent's view of single canvas objects (id, kind, page bounds, style, text) and the pure edits it may make: restyle, move/resize and replace text.
import { z } from "zod";
import {
  textStyleOf,
  textStyleSchema,
  type Bounds,
  type CanvasObject,
} from "@aurora/shared";
import { conflict } from "../errors.js";
import { objectText, textToDoc } from "../canvas/text.js";
import {
  MARK_COLOR,
  labelHeight,
  labelHtml,
  markStyleShape,
  practiceTagOf,
} from "../practice/marks.js";
import { PAGE_HEIGHT, PAGE_WIDTH } from "../practice/page.js";
import { toPageBounds, type NotePage } from "./pages.js";

// Font fields apply to typed text; color applies to text and drawn objects; strokeWidth to drawn objects.
export const objectStyleSchema = textStyleSchema.extend({
  strokeWidth: markStyleShape.strokeWidth,
});
export type ObjectStyle = z.infer<typeof objectStyleSchema>;

const FONT_FIELDS = ["fontFamily", "fontSize", "fontWeight", "fontStyle"];
const DRAWN_KINDS = ["stroke", "line", "arrow", "rectangle", "ellipse"];

/** Typed text with a font: rich-text boxes and label cards (text marks). */
function hasFont(object: CanvasObject): boolean {
  return (
    object.kind === "rich-text" ||
    (object.kind === "practice-card" && object.payload.variant === "label")
  );
}

/** Style fields this object can take. */
function styleFields(object: CanvasObject): string[] {
  if (hasFont(object)) return [...FONT_FIELDS, "color"];
  if (DRAWN_KINDS.includes(object.kind)) return ["color", "strokeWidth"];
  return [];
}

/** Who wrote an object: the user, or the agent (practice/annotation marks and agent text boxes). */
export function authorOf(object: CanvasObject): "user" | "agent" {
  return practiceTagOf(object) || object.payload.author === "agent"
    ? "agent"
    : "user";
}

/** The object's current style with renderer defaults filled in (rich-text without fontSize auto-fits its box). */
export function currentStyle(object: CanvasObject): Record<string, unknown> {
  const payload = object.payload;
  if (object.kind === "rich-text") {
    const style = textStyleOf(payload);
    return {
      fontFamily: style.fontFamily ?? "sans",
      fontSize: style.fontSize ?? "auto",
      fontWeight: style.fontWeight ?? "normal",
      fontStyle: style.fontStyle ?? "normal",
      color: typeof payload.color === "string" ? payload.color : "#e6e8ec",
    };
  }
  if (hasFont(object)) {
    // Labels stored before fonts existed render in the handwriting font.
    const style = textStyleOf(payload);
    return {
      fontFamily: style.fontFamily ?? "handwriting",
      fontSize: style.fontSize ?? 20,
      fontWeight: style.fontWeight ?? "normal",
      fontStyle: style.fontStyle ?? "normal",
      color: style.color ?? MARK_COLOR,
    };
  }
  if (DRAWN_KINDS.includes(object.kind)) {
    const width =
      object.kind === "stroke" ? payload.baseWidth : payload.strokeWidth;
    return {
      color: typeof payload.color === "string" ? payload.color : null,
      strokeWidth: typeof width === "number" ? width : null,
    };
  }
  if (object.kind === "sticky-note") {
    return { background: payload.color ?? null };
  }
  return {};
}

/** One object as the agent sees it, in the page's coordinates. */
export function describeObject(object: CanvasObject, page: NotePage) {
  const text = objectText(object);
  return {
    id: object.id,
    kind: object.kind,
    ...(object.kind === "practice-card"
      ? { variant: object.payload.variant ?? "prompt" }
      : {}),
    author: authorOf(object),
    locked: object.locked,
    pageIndex: page.index,
    ...toPageBounds(page, object.bounds),
    style: currentStyle(object),
    ...(text ? { text } : {}),
  };
}

/** The part of `style` that applies to this object (used for note-wide restyles). */
export function applicableStyle(
  object: CanvasObject,
  style: ObjectStyle,
): ObjectStyle {
  const fields = styleFields(object);
  return Object.fromEntries(
    Object.entries(style).filter(
      ([key, value]) => value !== undefined && fields.includes(key),
    ),
  );
}

/** Stores a style on the object's payload; throws for fields the object cannot take. */
export function applyStyle(
  object: CanvasObject,
  style: ObjectStyle,
): CanvasObject {
  const fields = styleFields(object);
  const unsupported = Object.keys(style).filter((key) => !fields.includes(key));
  if (unsupported.length > 0) {
    throw conflict(
      `${object.kind} ${object.id} cannot take ${unsupported.join(", ")}`,
    );
  }
  const { strokeWidth, ...rest } = style;
  const payload: Record<string, unknown> = { ...object.payload, ...rest };
  if (strokeWidth !== undefined) {
    payload[object.kind === "stroke" ? "baseWidth" : "strokeWidth"] =
      strokeWidth;
  }
  return { ...object, payload };
}

/** Moves and scales the object's coordinate payloads (stroke points, line endpoints) with its bounds. */
export function moveObject(object: CanvasObject, to: Bounds): CanvasObject {
  const from = object.bounds;
  const map = (x: number, y: number): [number, number] => [
    to.x + (x - from.x) * (to.width / from.width),
    to.y + (y - from.y) * (to.height / from.height),
  ];
  const payload = { ...object.payload };
  if (object.kind === "stroke" && Array.isArray(payload.points)) {
    payload.points = (payload.points as number[][]).map(([x, y, pressure]) => [
      ...map(x ?? 0, y ?? 0),
      pressure ?? 0.5,
    ]);
  }
  for (const key of ["start", "end"]) {
    const point = payload[key] as { x?: unknown; y?: unknown } | undefined;
    if (typeof point?.x === "number" && typeof point.y === "number") {
      const [x, y] = map(point.x, point.y);
      payload[key] = { ...point, x, y };
    }
  }
  return { ...object, bounds: to, payload };
}

/** Replaces the typed text of a rich-text box (as plain paragraphs), sticky note or label card. */
export function replaceText(object: CanvasObject, text: string): CanvasObject {
  if (object.kind === "rich-text") {
    return { ...object, payload: { ...object.payload, doc: textToDoc(text) } };
  }
  if (object.kind === "sticky-note") {
    return { ...object, payload: { ...object.payload, text } };
  }
  if (hasFont(object)) {
    return { ...object, payload: { ...object.payload, html: labelHtml(text) } };
  }
  throw conflict(`${object.kind} ${object.id} has no editable text`);
}

export const objectEditSchema = z.object({
  id: z.string().uuid(),
  pageIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Page to move the object to; default its current page"),
  x: z.number().min(0).max(PAGE_WIDTH).optional().describe("New left edge"),
  y: z.number().min(0).max(PAGE_HEIGHT).optional().describe("New top edge"),
  width: z.number().positive().max(PAGE_WIDTH).optional(),
  height: z.number().positive().max(PAGE_HEIGHT).optional(),
  text: z
    .string()
    .min(1)
    .max(10_000)
    .optional()
    .describe(
      "New text (rich-text, sticky-note, text mark); replaces it as plain paragraphs",
    ),
  style: objectStyleSchema.optional(),
});
export type ObjectEdit = z.infer<typeof objectEditSchema>;

/**
 * Applies one edit. `page` holds the object now; `target` is where it goes (the same page unless
 * the edit moves it). Position, size, text and style each change only when given.
 */
export function editObject(
  object: CanvasObject,
  page: NotePage,
  target: NotePage,
  edit: ObjectEdit,
): CanvasObject {
  let next = object;
  if (edit.text !== undefined) next = replaceText(next, edit.text);
  if (edit.style) next = applyStyle(next, edit.style);
  let height = edit.height ?? object.bounds.height;
  // A label card grows or shrinks with its text unless a height is given.
  if (edit.height === undefined && hasFont(next) && next.kind !== "rich-text") {
    if (edit.text !== undefined || edit.style?.fontSize !== undefined) {
      height = labelHeight(
        objectText(next) ?? "",
        edit.width ?? object.bounds.width,
        textStyleOf(next.payload).fontSize,
      );
    }
  }
  // Unchanged coordinates keep their exact page-relative position.
  const bounds = {
    x: target.origin.x + (edit.x ?? object.bounds.x - page.origin.x),
    y: target.origin.y + (edit.y ?? object.bounds.y - page.origin.y),
    width: edit.width ?? object.bounds.width,
    height,
  };
  return moveObject(next, bounds);
}
