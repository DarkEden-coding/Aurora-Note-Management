import { describe, expect, it } from "vitest";
import type { Background, CanvasObject } from "@aurora/shared";
import { makeCanvasObject } from "../canvas/objects";
import { PAGE_GAP, PAGE_HEIGHT, PAGE_WIDTH } from "../canvas/pageLayout";
import { planPdfPages } from "./noteSnapshot";

const BACKGROUND: Background = {
  pattern: "dot-grid",
  color: "#171a21",
  patternColor: "#354052",
  spacing: 24,
};
const NOTE_ID = "00000000-0000-4000-8000-00000000b001";
const OWNER_ID = "00000000-0000-4000-8000-00000000a001";

function objectAt(x: number, y: number): CanvasObject {
  return makeCanvasObject({
    id: crypto.randomUUID(),
    ownerId: OWNER_ID,
    noteId: NOTE_ID,
    kind: "rectangle",
    bounds: { x, y, width: 20, height: 20 },
    zIndex: 1,
    payload: {},
  });
}

describe("PDF page planning", () => {
  it("exports persisted paged notes as full page-sized regions", () => {
    const pages = Array.from({ length: 3 }, (_, pageIndex) => ({
      id: crypto.randomUUID(),
      noteId: NOTE_ID,
      pageIndex,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      background: BACKGROUND,
    }));
    const regions = planPdfPages("paged", BACKGROUND, [], pages);

    expect(regions).toHaveLength(3);
    expect(regions[2]).toEqual({
      x: 0,
      y: 2 * (PAGE_HEIGHT + PAGE_GAP),
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      background: BACKGROUND,
    });
  });

  it("covers content in fixed and infinite canvas modes", () => {
    expect(
      planPdfPages("fixed-width", BACKGROUND, [objectAt(0, 1400)], []),
    ).toHaveLength(2);
    expect(
      planPdfPages("fixed-height", BACKGROUND, [objectAt(1000, 0)], []),
    ).toHaveLength(2);
    expect(
      planPdfPages("infinite", BACKGROUND, [objectAt(1000, 1400)], []),
    ).toHaveLength(4);
  });

  it("exports imported PDF references as their original page regions", () => {
    const imported = {
      ...objectAt(0, 0),
      kind: "pdf-page-reference" as const,
      bounds: { x: 0, y: 0, width: 612, height: 792 },
      payload: { importedDocument: true },
    };
    expect(planPdfPages("paged", BACKGROUND, [imported], [])).toEqual([
      { ...imported.bounds, background: BACKGROUND },
    ]);
  });
});
