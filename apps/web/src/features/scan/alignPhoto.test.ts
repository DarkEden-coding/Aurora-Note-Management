import { describe, expect, it } from "vitest";
import { alignToView, rotateGray, toGray, type Gray } from "./alignPhoto";
import { blankImage, fillPolygon } from "./testScene";

/** A landscape scene with shapes in distinct places, so every turn looks different. */
function scene(): Gray {
  const image = blankImage(400, 300, 90);
  fillPolygon(
    image,
    [
      { x: 40, y: 30 },
      { x: 220, y: 40 },
      { x: 210, y: 160 },
      { x: 50, y: 150 },
    ],
    230,
  );
  fillPolygon(
    image,
    [
      { x: 260, y: 180 },
      { x: 380, y: 170 },
      { x: 370, y: 280 },
    ],
    20,
  );
  fillPolygon(
    image,
    [
      { x: 70, y: 200 },
      { x: 160, y: 210 },
      { x: 150, y: 270 },
      { x: 60, y: 260 },
    ],
    160,
  );
  return toGray(image);
}

/** The centered `fraction` of an image, resampled to `width`×`height` (nearest pixel). */
function centerCrop(
  image: Gray,
  fraction: number,
  width: number,
  height: number,
): Gray {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const u = 0.5 + ((x + 0.5) / width - 0.5) * fraction;
      const v = 0.5 + ((y + 0.5) / height - 0.5) * fraction;
      data[y * width + x] =
        image.data[
          Math.floor(v * image.height) * image.width +
            Math.floor(u * image.width)
        ]!;
    }
  return { data, width, height };
}

describe("alignToView", () => {
  it("finds a still that came back turned and wider than the zoomed preview", () => {
    const still = scene();
    // The preview is the still turned a quarter clockwise, zoomed to the middle 70%.
    const view = centerCrop(rotateGray(still, 1), 0.7, 150, 200);
    const found = alignToView(still, view);
    expect(found.turns).toBe(1);
    expect(found.crop.width).toBeCloseTo(0.7, 1);
    expect(found.crop.height).toBeCloseTo(0.7, 1);
    expect(found.score).toBeGreaterThan(0.9);
  });

  it("leaves a matching still as it is", () => {
    const still = scene();
    const found = alignToView(still, centerCrop(still, 1, 200, 150));
    expect(found.turns).toBe(0);
    expect(found.crop.width).toBeCloseTo(1, 1);
  });
});
