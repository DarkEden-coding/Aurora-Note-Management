// Live selection drag: per-object offsets match the page clamping applied on release.
import { describe, expect, it } from "vitest";
import { PAGE_WIDTH } from "./pageLayout";
import { clampedMoveOffsets } from "./selectionDrag";

describe("clampedMoveOffsets", () => {
  const origins = new Map([
    ["left", { x: 10, y: 10, width: 40, height: 40 }],
    ["edge", { x: PAGE_WIDTH - 60, y: 10, width: 40, height: 40 }],
  ]);

  it("stops each object at the page edge on its own", () => {
    const offsets = clampedMoveOffsets(origins, { x: 50, y: 5 }, "paged");
    expect(offsets.get("left")).toEqual({ x: 50, y: 5 });
    expect(offsets.get("edge")).toEqual({ x: 20, y: 5 });
  });

  it("moves freely on an infinite canvas", () => {
    const offsets = clampedMoveOffsets(origins, { x: 500, y: -30 }, "infinite");
    expect(offsets.get("edge")).toEqual({ x: 500, y: -30 });
  });
});
