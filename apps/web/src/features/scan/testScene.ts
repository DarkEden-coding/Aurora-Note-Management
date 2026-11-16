// Test helpers: projects a rectangle through a pinhole camera and paints synthetic photos for the detector tests.
import type { PixelImage } from "./detectDocument";
import { insideConvex, type Point, type Quad } from "./quadGeometry";

/**
 * Corners of a width×height rectangle seen by a camera with focal length `focal`,
 * centered in a `frame`, turned `yaw` and tilted `pitch` radians, `distance` away.
 */
export function projectRectangle(options: {
  width: number;
  height: number;
  yaw: number;
  pitch: number;
  distance: number;
  focal: number;
  frame: { width: number; height: number };
}): Quad {
  const { width, height, yaw, pitch, distance, focal, frame } = options;
  const corners: [number, number][] = [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ];
  const project = ([x, y]: [number, number]): Point => {
    // Yaw about the vertical axis, then pitch about the horizontal axis.
    const x1 = x * Math.cos(yaw);
    const z1 = x * Math.sin(yaw);
    const y2 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
    const z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch) + distance;
    return {
      x: frame.width / 2 + (focal * x1) / z2,
      y: frame.height / 2 + (focal * y2) / z2,
    };
  };
  return corners.map(project) as Quad;
}

export function blankImage(
  width: number,
  height: number,
  gray: number,
): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = gray;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

export function fillPolygon(
  image: PixelImage,
  polygon: readonly Point[],
  gray: number,
): void {
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(image.height - 1, Math.ceil(Math.max(...ys)));
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(image.width - 1, Math.ceil(Math.max(...xs)));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!insideConvex({ x: x + 0.5, y: y + 0.5 }, polygon)) continue;
      const k = (y * image.width + x) * 4;
      image.data[k] = image.data[k + 1] = image.data[k + 2] = gray;
    }
  }
}

/** Point at (u, v) in [0, 1]² inside a quad, by bilinear interpolation. */
export function pointInQuad(
  [tl, tr, br, bl]: Quad,
  u: number,
  v: number,
): Point {
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bottom = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return {
    x: top.x + (bottom.x - top.x) * v,
    y: top.y + (bottom.y - top.y) * v,
  };
}
