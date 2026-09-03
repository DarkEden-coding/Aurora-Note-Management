// Focused tests for regional culling: viewport-plus-overscan selection and z-order sorting.
import { describe, expect, it } from "vitest";
import type { Bounds, CanvasObject } from "@aurora/shared";
import {
  queryVisibleObjects,
  sortByZIndex,
  sortByZIndexDescending,
} from "./culling";
import { makeCanvasObject } from "./objects";

const VIEW: Bounds = { x: 0, y: 0, width: 100, height: 100 };

function objectAt(id: string, bounds: Bounds, zIndex: number): CanvasObject {
  return makeCanvasObject({
    id,
    ownerId: "00000000-0000-4000-8000-00000000a001",
    noteId: "00000000-0000-4000-8000-00000000b001",
    kind: "rectangle",
    bounds,
    zIndex,
    payload: {},
  });
}

describe("queryVisibleObjects", () => {
  it("keeps objects inside the view and within overscan, drops distant ones", () => {
    const objects = [
      objectAt(
        "00000000-0000-4000-8000-00000000c001",
        { x: 10, y: 10, width: 10, height: 10 },
        1,
      ),
      objectAt(
        "00000000-0000-4000-8000-00000000c002",
        { x: 300, y: 300, width: 10, height: 10 },
        2,
      ),
      objectAt(
        "00000000-0000-4000-8000-00000000c003",
        { x: 120, y: 0, width: 10, height: 10 },
        3,
      ),
    ];
    const visible = queryVisibleObjects(objects, VIEW, 64);
    expect(visible.map((o) => o.id)).toEqual([
      "00000000-0000-4000-8000-00000000c001",
      "00000000-0000-4000-8000-00000000c003",
    ]);
  });

  it("expands the region by the overscan amount", () => {
    const far = objectAt(
      "00000000-0000-4000-8000-00000000c004",
      { x: 105, y: 0, width: 10, height: 10 },
      1,
    );
    expect(queryVisibleObjects([far], VIEW, 0)).toEqual([]);
    expect(queryVisibleObjects([far], VIEW, 10)).toEqual([far]);
  });
});

describe("z-order sorting", () => {
  it("sorts ascending with stable ties and reverses for descending", () => {
    const a = objectAt(
      "00000000-0000-4000-8000-00000000c005",
      { x: 0, y: 0, width: 1, height: 1 },
      2,
    );
    const b = objectAt(
      "00000000-0000-4000-8000-00000000c006",
      { x: 0, y: 0, width: 1, height: 1 },
      1,
    );
    const c = objectAt(
      "00000000-0000-4000-8000-00000000c007",
      { x: 0, y: 0, width: 1, height: 1 },
      2,
    );
    const sorted = sortByZIndex([a, b, c]);
    expect(sorted).toEqual([b, a, c]);
    expect(sortByZIndexDescending([b, a, c])).toEqual([c, a, b]);
  });
});
