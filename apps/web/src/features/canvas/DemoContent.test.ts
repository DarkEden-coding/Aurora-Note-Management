// Focused tests for demo content: every demo object validates against the shared canvasObjectSchema and covers all object kinds.
import { describe, expect, it } from "vitest";
import { canvasObjectSchema } from "@aurora/shared";
import { buildDemoObjects } from "./DemoContent";

const NOTE_ID = "00000000-0000-4000-8000-000000000999";

describe("buildDemoObjects", () => {
  it("produces contract-valid objects", () => {
    const objects = buildDemoObjects(NOTE_ID);
    expect(objects.length).toBeGreaterThan(0);
    for (const o of objects) {
      const result = canvasObjectSchema.safeParse(o);
      expect(result.success).toBe(true);
      expect(o.noteId).toBe(NOTE_ID);
    }
  });

  it("covers every object kind with unique ids and z-order", () => {
    const objects = buildDemoObjects(NOTE_ID);
    const kinds = new Set(objects.map((o) => o.kind));
    expect(kinds).toEqual(
      new Set([
        "rich-text",
        "stroke",
        "rectangle",
        "ellipse",
        "line",
        "arrow",
        "sticky-note",
        "image",
        "attachment",
        "pdf-page-reference",
      ]),
    );
    expect(new Set(objects.map((o) => o.id)).size).toBe(objects.length);
    const z = objects.map((o) => o.zIndex);
    expect(new Set(z).size).toBe(z.length);
  });

  it("carries a stroke payload with pressure points", () => {
    const stroke = buildDemoObjects(NOTE_ID).find((o) => o.kind === "stroke");
    expect(stroke).toBeDefined();
    const points = stroke?.payload.points;
    expect(Array.isArray(points)).toBe(true);
    expect((points as unknown[]).length).toBeGreaterThan(10);
  });

  it("references a page of the same note for pdf-page-reference objects", () => {
    const ref = buildDemoObjects(NOTE_ID).find(
      (o) => o.kind === "pdf-page-reference",
    );
    expect(ref?.payload.sourceNoteId).toBe(NOTE_ID);
    expect(ref?.payload.pageNumber).toBe(1);
  });
});
