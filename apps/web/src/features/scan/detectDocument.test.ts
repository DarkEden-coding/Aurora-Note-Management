import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { detectDocument, flattenDocument } from "./detectDocument";
import { whenOpenCvReady, type OpenCv } from "./opencv";
import type { Point, Quad } from "./quadGeometry";
import {
  blankImage,
  fillPolygon,
  pointInQuad,
  projectRectangle,
} from "./testScene";

let cv: OpenCv;
beforeAll(async () => {
  cv = await whenOpenCvReady(
    createRequire(import.meta.url)("@techstark/opencv-js"),
  );
}, 30_000);

const frame = { width: 900, height: 1200 };
const camera = { yaw: 0.45, pitch: -0.25, distance: 14, focal: 1100, frame };

/** A dim lecture hall: a gray projector screen holding a bright 4:3 slide, a blackboard below, and a clicker toolbar over the slide's top-left corner. */
function lectureScene(): { image: ReturnType<typeof blankImage>; slide: Quad } {
  const image = blankImage(frame.width, frame.height, 70);
  const screen = projectRectangle({ ...camera, width: 5, height: 4 });
  const slide = projectRectangle({ ...camera, width: 4, height: 3 });
  const board = projectRectangle({
    ...camera,
    width: 6,
    height: 1.6,
  }).map((p) => ({ x: p.x, y: p.y + 330 }));
  fillPolygon(image, board, 25);
  fillPolygon(image, screen, 150);
  fillPolygon(image, slide, 235);
  // Text lines on the slide.
  for (let line = 0; line < 6; line += 1) {
    const v = 0.15 + line * 0.12;
    fillPolygon(
      image,
      [
        pointInQuad(slide, 0.1, v),
        pointInQuad(slide, 0.8, v),
        pointInQuad(slide, 0.8, v + 0.04),
        pointInQuad(slide, 0.1, v + 0.04),
      ],
      60,
    );
  }
  // Toolbar: starts outside the slide's left edge and covers its top-left corner.
  const toolbar = [
    pointInQuad(slide, -0.12, -0.02),
    pointInQuad(slide, 0.12, -0.02),
    pointInQuad(slide, 0.12, 0.07),
    pointInQuad(slide, -0.12, 0.07),
  ];
  fillPolygon(image, toolbar, 200);
  return { image, slide };
}

function maxCornerError(found: Quad, expected: Quad): number {
  return Math.max(
    ...found.map((p: Point, i) =>
      Math.hypot(
        p.x * frame.width - expected[i]!.x,
        p.y * frame.height - expected[i]!.y,
      ),
    ),
  );
}

describe("detectDocument", () => {
  it("finds the slide, not the screen around it, even with its corner covered", () => {
    const { image, slide } = lectureScene();
    const found = detectDocument(cv, image);
    expect(found).not.toBeNull();
    expect(maxCornerError(found!, slide)).toBeLessThan(4);
  });

  it("finds a whole chalkboard made of two stacked panels", () => {
    // A light frame holding two dark panels, seen off-angle on a mid-gray wall.
    const view = { ...camera, distance: 9 };
    const image = blankImage(frame.width, frame.height, 120);
    const frameQuad = projectRectangle({ ...view, width: 5.2, height: 4.2 });
    const board = projectRectangle({ ...view, width: 5, height: 4 });
    fillPolygon(image, frameQuad, 200);
    fillPolygon(image, board, 35);
    // The divider between the panels.
    fillPolygon(
      image,
      [
        pointInQuad(board, 0, 0.49),
        pointInQuad(board, 1, 0.49),
        pointInQuad(board, 1, 0.51),
        pointInQuad(board, 0, 0.51),
      ],
      200,
    );
    const found = detectDocument(cv, image);
    expect(found).not.toBeNull();
    expect(maxCornerError(found!, board)).toBeLessThan(6);
  });

  it("returns null when there is nothing rectangular", () => {
    expect(detectDocument(cv, blankImage(400, 300, 90))).toBeNull();
  });
});

describe("flattenDocument", () => {
  it("flattens the slide to its true 4:3 shape", () => {
    const { image, slide } = lectureScene();
    const normalized = slide.map((p) => ({
      x: p.x / frame.width,
      y: p.y / frame.height,
    })) as Quad;
    const flat = flattenDocument(cv, image, normalized, 4096);
    expect(flat.width / flat.height).toBeCloseTo(4 / 3, 1);
    // The middle of a text line is dark, the margin beside it is bright.
    const gray = (u: number, v: number): number =>
      flat.data[
        (Math.round(v * flat.height) * flat.width +
          Math.round(u * flat.width)) *
          4
      ]!;
    expect(gray(0.45, 0.17)).toBeLessThan(100);
    expect(gray(0.9, 0.17)).toBeGreaterThan(200);
  });
});
