// Focused tests for canvas mode geometry: paged frames, page mapping, mode clamping, and in-mode translation.
import { describe, expect, it } from "vitest";
import type { Bounds, CanvasObject } from "@aurora/shared";
import {
  PAGE_GAP,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  clampBoundsToMode,
  clampBoundsToRegion,
  fixedAxis,
  pageFrameAtPoint,
  pageFrames,
  pagedPageCount,
  pagedPageFrame,
  pagedPageIndexAtY,
  translateBoundsInMode,
} from "./pageLayout";
import { makeCanvasObject } from "./objects";

const NOTE_ID = "00000000-0000-4000-8000-00000000b001";
const OWNER_ID = "00000000-0000-4000-8000-00000000a001";

function objectAt(bounds: Bounds): CanvasObject {
  return makeCanvasObject({
    id: "00000000-0000-4000-8000-00000000c001",
    ownerId: OWNER_ID,
    noteId: NOTE_ID,
    kind: "rectangle",
    bounds,
    zIndex: 1,
    payload: {},
  });
}

describe("paged layout", () => {
  it("stacks page frames vertically below the origin", () => {
    expect(pagedPageFrame(0)).toEqual({
      x: 0,
      y: 0,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
    });
    expect(pagedPageFrame(2)).toEqual({
      x: 0,
      y: 2 * (PAGE_HEIGHT + PAGE_GAP),
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
    });
  });

  it("maps y coordinates to page indices", () => {
    expect(pagedPageIndexAtY(0)).toBe(0);
    expect(pagedPageIndexAtY(PAGE_HEIGHT - 1)).toBe(0);
    expect(pagedPageIndexAtY(PAGE_HEIGHT + PAGE_GAP)).toBe(1);
    expect(pagedPageIndexAtY(-100)).toBe(0);
  });

  it("always shows at least one page and grows with content", () => {
    expect(pagedPageCount([])).toBe(1);
    expect(
      pagedPageCount([
        objectAt({
          x: 0,
          y: PAGE_HEIGHT + PAGE_GAP + 10,
          width: 10,
          height: 10,
        }),
      ]),
    ).toBe(2);
  });

  it("finds the frame containing a point", () => {
    const objects = [objectAt({ x: 0, y: 0, width: 10, height: 10 })];
    const frames = pageFrames(objects, "paged");
    expect(frames).toHaveLength(1);
    expect(pageFrameAtPoint(objects, "paged", { x: 10, y: 10 })).toEqual(
      frames[0],
    );
    expect(
      pageFrameAtPoint(objects, "paged", { x: PAGE_WIDTH + 5, y: 10 }),
    ).toBeNull();
    expect(pageFrames(objects, "infinite")).toEqual([]);
  });
});

describe("mode clamping", () => {
  it("reports the fixed axis per mode", () => {
    expect(fixedAxis("infinite")).toBe("none");
    expect(fixedAxis("fixed-width")).toBe("x");
    expect(fixedAxis("fixed-height")).toBe("y");
    expect(fixedAxis("paged")).toBe("none");
  });

  it("keeps fixed-width content inside the page columns", () => {
    const b = { x: PAGE_WIDTH - 50, y: 0, width: 100, height: 10 };
    expect(clampBoundsToMode(b, "fixed-width").x).toBe(PAGE_WIDTH - 100);
  });

  it("keeps fixed-height content inside the page rows", () => {
    const b = { x: 0, y: PAGE_HEIGHT - 50, width: 10, height: 100 };
    expect(clampBoundsToMode(b, "fixed-height").y).toBe(PAGE_HEIGHT - 100);
  });

  it("keeps paged content inside page width while y stays free", () => {
    const b = { x: PAGE_WIDTH - 50, y: 5000, width: 100, height: 10 };
    const clamped = clampBoundsToMode(b, "paged");
    expect(clamped.x).toBe(PAGE_WIDTH - 100);
    expect(clamped.y).toBe(5000);
  });

  it("leaves infinite content untouched", () => {
    const b = { x: -9999, y: 9999, width: 10, height: 10 };
    expect(clampBoundsToMode(b, "infinite")).toEqual(b);
  });

  it("handles oversized content in finite regions", () => {
    const b = { x: 0, y: 0, width: 5000, height: 10 };
    const clamped = clampBoundsToRegion(b, {
      x: 0,
      y: 0,
      width: 1000,
      height: 1000,
    });
    expect(clamped.x).toBe(0);
    expect(clamped.width).toBe(5000);
  });

  it("translates inside the mode region", () => {
    const b = { x: PAGE_WIDTH - 60, y: 0, width: 100, height: 10 };
    expect(translateBoundsInMode(b, 100, 0, "fixed-width").x).toBe(
      PAGE_WIDTH - 100,
    );
    expect(translateBoundsInMode(b, 10, 20, "infinite")).toEqual({
      x: PAGE_WIDTH - 50,
      y: 20,
      width: 100,
      height: 10,
    });
  });
});
