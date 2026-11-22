// Agent object edits: describing objects with their style, moving/resizing/retexting, restyling, and styled annotations.
import { describe, expect, it } from "vitest";
import { textStyleOf, type CanvasObject } from "@aurora/shared";
import { annotationObjects } from "../src/agent/notes.js";
import {
  applicableStyle,
  applyStyle,
  describeObject,
  editObject,
} from "../src/agent/objects.js";
import { objectText, textToDoc } from "../src/canvas/text.js";
import { buildPageSvg } from "../src/practice/render.js";

const ownerId = "55555555-5555-4555-8555-555555555555";
const noteId = "22222222-2222-4222-8222-222222222222";
const page0 = { index: 0, origin: { x: 0, y: 0 } };
const page1 = { index: 1, origin: { x: 0, y: 1080 } };

function object(
  kind: CanvasObject["kind"],
  bounds: CanvasObject["bounds"],
  payload: Record<string, unknown>,
): CanvasObject {
  return {
    id: crypto.randomUUID(),
    ownerId,
    noteId,
    pageId: null,
    kind,
    bounds,
    rotation: 0,
    zIndex: 0,
    locked: false,
    groupId: null,
    payload,
    revision: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("styled annotations", () => {
  it("defaults agent text to sans-serif and keeps the requested style", () => {
    const [mark, comment, box] = annotationObjects(
      ownerId,
      noteId,
      page0,
      [
        {
          type: "box",
          x: 10,
          y: 10,
          width: 50,
          height: 50,
          color: "#1f6feb",
          strokeWidth: 5,
        },
        { type: "text", x: 100, y: 100, text: "Nice" },
      ],
      [
        {
          x: 100,
          y: 300,
          width: 400,
          text: "Summary",
          color: "#222222",
          fontWeight: "bold",
        },
      ],
    );
    expect(mark!.payload).toMatchObject({ color: "#1f6feb", strokeWidth: 5 });
    expect(comment!.payload).toMatchObject({
      variant: "label",
      fontFamily: "sans",
    });
    expect(box!.payload).toMatchObject({
      fontFamily: "sans",
      fontSize: 18,
      fontWeight: "bold",
      color: "#222222",
    });
    expect(describeObject(box!, page0)).toMatchObject({
      kind: "rich-text",
      author: "agent",
      x: 100,
      y: 300,
      style: {
        fontFamily: "sans",
        fontSize: 18,
        fontWeight: "bold",
        color: "#222222",
      },
      text: "Summary",
    });
  });

  it("renders the stored font and color in page images", () => {
    const [comment] = annotationObjects(
      ownerId,
      noteId,
      page0,
      [
        {
          type: "text",
          x: 10,
          y: 10,
          text: "Units?",
          fontFamily: "serif",
          color: "#00aa00",
        },
      ],
      [],
    );
    const svg = buildPageSvg([comment!], { pageIndex: 0, attempt: 1 });
    expect(svg).toContain("DejaVu Serif");
    expect(svg).toContain('fill="#00aa00"');
  });
});

describe("object edits", () => {
  it("moves a stroke to another page and scales its points with its bounds", () => {
    const stroke = object(
      "stroke",
      { x: 100, y: 100, width: 100, height: 50 },
      {
        points: [
          [100, 100, 0.4],
          [200, 150, 0.6],
        ],
        color: "#ffffff",
        baseWidth: 2,
      },
    );
    const moved = editObject(stroke, page0, page1, {
      id: stroke.id,
      width: 200,
    });
    expect(moved.bounds).toEqual({ x: 100, y: 1180, width: 200, height: 50 });
    expect(moved.payload.points).toEqual([
      [100, 1180, 0.4],
      [300, 1230, 0.6],
    ]);
    expect(moved.revision).toBe(3);
  });

  it("replaces a text mark's text and refits its height to a new font size", () => {
    const [label] = annotationObjects(
      ownerId,
      noteId,
      page0,
      [{ type: "text", x: 10, y: 10, text: "a", width: 200 }],
      [],
    );
    const edited = editObject(label!, page0, page0, {
      id: label!.id,
      text: "Check the sign\non line 2",
      style: { fontSize: 30, fontFamily: "mono" },
    });
    expect(objectText(edited)).toBe("Check the sign\non line 2");
    expect(edited.bounds.height).toBeGreaterThan(label!.bounds.height);
    expect(textStyleOf(edited.payload)).toMatchObject({
      fontSize: 30,
      fontFamily: "mono",
    });
  });

  it("maps strokeWidth per kind and rejects fonts on drawn objects", () => {
    const stroke = object(
      "stroke",
      { x: 0, y: 0, width: 10, height: 10 },
      { points: [] },
    );
    expect(
      applyStyle(stroke, { strokeWidth: 4, color: "#123456" }).payload,
    ).toMatchObject({
      baseWidth: 4,
      color: "#123456",
    });
    expect(() => applyStyle(stroke, { fontFamily: "serif" })).toThrow(
      /cannot take fontFamily/,
    );

    const text = object(
      "rich-text",
      { x: 0, y: 0, width: 10, height: 10 },
      { doc: textToDoc("x") },
    );
    expect(
      applicableStyle(text, { fontFamily: "serif", strokeWidth: 4 }),
    ).toEqual({
      fontFamily: "serif",
    });
  });
});
