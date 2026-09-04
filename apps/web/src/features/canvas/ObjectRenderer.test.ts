// Verifies SVG shape fill and opacity rendering.
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { makeCanvasObject } from "./objects";
import { SceneObject } from "./ObjectRenderer";

const BASE = {
  id: "00000000-0000-4000-8000-00000000c020",
  ownerId: "00000000-0000-4000-8000-00000000a001",
  noteId: "00000000-0000-4000-8000-00000000b001",
  bounds: { x: 0, y: 0, width: 40, height: 20 },
  zIndex: 1,
} as const;

describe("shape fill rendering", () => {
  it("renders persisted fill opacity as the SVG zero-to-one value", () => {
    const object = makeCanvasObject({
      ...BASE,
      kind: "rectangle",
      payload: { fill: "#336699", fillOpacity: 35 },
    });
    const element = SceneObject({ object }) as ReactElement<{
      fill: string;
      fillOpacity: number;
    }>;
    expect(element.props.fill).toBe("#336699");
    expect(element.props.fillOpacity).toBe(0.35);
  });

  it("renders absent fills transparently and legacy fills opaquely", () => {
    const transparent = SceneObject({
      object: makeCanvasObject({
        ...BASE,
        kind: "ellipse",
        payload: {},
      }),
    }) as ReactElement<{ fill: string; fillOpacity: number }>;
    expect(transparent.props.fill).toBe("none");

    const legacy = SceneObject({
      object: makeCanvasObject({
        ...BASE,
        kind: "ellipse",
        payload: { fill: "#abcdef" },
      }),
    }) as ReactElement<{ fill: string; fillOpacity: number }>;
    expect(legacy.props.fillOpacity).toBe(1);
  });
});
