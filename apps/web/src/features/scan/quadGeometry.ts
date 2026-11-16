// Pure geometry for document scanning: quad validation, corner ordering, line fitting, and the true aspect ratio of a photographed rectangle.

export interface Point {
  x: number;
  y: number;
}

/** Four corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

/** A line through `p` with unit direction `d`. */
export interface Line {
  p: Point;
  d: Point;
}

export function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  });
  return Math.abs(sum) / 2;
}

export function centroid(points: readonly Point[]): Point {
  const sum = points.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), {
    x: 0,
    y: 0,
  });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** True when the point lies inside or on a convex polygon. */
export function insideConvex(point: Point, polygon: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const side = Math.sign(
      (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x),
    );
    if (side === 0) continue;
    if (sign === 0) sign = side;
    else if (side !== sign) return false;
  }
  return true;
}

/** True when every corner turns the same way, so the quad can be flattened. */
export function isConvexQuad(quad: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const c = quad[(i + 2) % 4]!;
    const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (turn === 0) return false;
    if (sign === 0) sign = Math.sign(turn);
    else if (Math.sign(turn) !== sign) return false;
  }
  return true;
}

/**
 * True for a convex quad whose corners all fall between about 41° and 139°.
 * Perspective skews a rectangle's corners, but not past this.
 */
export function isPlausibleQuad(quad: readonly Point[]): boolean {
  if (!isConvexQuad(quad)) return false;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const c = quad[(i + 2) % 4]!;
    const u = { x: a.x - b.x, y: a.y - b.y };
    const v = { x: c.x - b.x, y: c.y - b.y };
    const cos =
      (u.x * v.x + u.y * v.y) / Math.hypot(u.x, u.y) / Math.hypot(v.x, v.y);
    if (Math.abs(cos) > 0.75) return false;
  }
  return true;
}

export function lineThrough(a: Point, b: Point): Line {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  return { p: a, d: { x: (b.x - a.x) / length, y: (b.y - a.y) / length } };
}

export function intersectLines(a: Line, b: Line): Point | null {
  const det = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / det;
  return { x: a.p.x + t * a.d.x, y: a.p.y + t * a.d.y };
}

export function distanceToLine(line: Line, point: Point): number {
  return Math.abs(
    (point.x - line.p.x) * -line.d.y + (point.y - line.p.y) * line.d.x,
  );
}

/** Total-least-squares line through the points. */
export function fitLine(points: readonly Point[]): Line {
  const mean = centroid(points);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - mean.x;
    const dy = p.y - mean.y;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: mean, d: { x: Math.cos(angle), y: Math.sin(angle) } };
}

/**
 * Reduces a polygon to the quad formed by extending its four longest sides.
 * This recovers a corner that was clipped or hidden by something in front of it.
 */
export function quadFromPolygon(polygon: readonly Point[]): Point[] | null {
  if (polygon.length < 4) return null;
  if (polygon.length === 4) return [...polygon];
  const n = polygon.length;
  const sides = polygon.map((a, i) => {
    const b = polygon[(i + 1) % n]!;
    return { i, length: Math.hypot(b.x - a.x, b.y - a.y) };
  });
  const kept = sides
    .sort((a, b) => b.length - a.length)
    .slice(0, 4)
    .map((side) => side.i)
    .sort((a, b) => a - b);
  const lines = kept.map((i) =>
    lineThrough(polygon[i]!, polygon[(i + 1) % n]!),
  );
  const quad: Point[] = [];
  for (let k = 0; k < 4; k += 1) {
    const corner = intersectLines(lines[k]!, lines[(k + 1) % 4]!);
    if (!corner) return null;
    quad.push(corner);
  }
  return quad;
}

/** Orders four corners as top-left, top-right, bottom-right, bottom-left (y grows downward). */
export function orderCorners(points: readonly Point[]): Quad {
  const center = centroid(points);
  const clockwise = [...points].sort(
    (a, b) =>
      Math.atan2(a.y - center.y, a.x - center.x) -
      Math.atan2(b.y - center.y, b.x - center.x),
  );
  let start = 0;
  clockwise.forEach((p, i) => {
    const first = clockwise[start]!;
    if (p.x + p.y < first.x + first.y) start = i;
  });
  const at = (i: number): Point => clockwise[(start + i) % 4]!;
  return [at(0), at(1), at(2), at(3)];
}

type Vec3 = [number, number, number];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Width/height of the real rectangle behind a photographed quad (pixel corners).
 * Uses Zhang & He's whiteboard-scanning method, which recovers the camera's
 * focal length from the vanishing geometry with the principal point at the
 * image center. Near head-on shots have no usable vanishing points, so those
 * fall back to the ratio of average edge lengths, which is accurate there.
 */
export function rectangleAspect(
  [tl, tr, br, bl]: Quad,
  imageWidth: number,
  imageHeight: number,
): number {
  const length = (a: Point, b: Point): number =>
    Math.hypot(b.x - a.x, b.y - a.y);
  const fallback =
    (length(tl, tr) + length(bl, br)) / (length(tl, bl) + length(tr, br));
  const toCamera = (p: Point): Vec3 => [
    p.x - imageWidth / 2,
    p.y - imageHeight / 2,
    1,
  ];
  const m1 = toCamera(tl);
  const m2 = toCamera(tr);
  const m3 = toCamera(bl);
  const m4 = toCamera(br);
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  const n2 = m2.map((v, i) => k2 * v - m1[i]!) as Vec3;
  const n3 = m3.map((v, i) => k3 * v - m1[i]!) as Vec3;
  const denominator = n2[2] * n3[2];
  if (Math.abs(denominator) < 1e-6) return fallback;
  const focalSquared = -(n2[0] * n3[0] + n2[1] * n3[1]) / denominator;
  if (!(focalSquared > 0)) return fallback;
  const aspect = Math.sqrt(
    (n2[0] ** 2 + n2[1] ** 2 + focalSquared * n2[2] ** 2) /
      (n3[0] ** 2 + n3[1] ** 2 + focalSquared * n3[2] ** 2),
  );
  return Number.isFinite(aspect) && aspect > 0.1 && aspect < 10
    ? aspect
    : fallback;
}

/**
 * Output pixel size for flattening a quad: the true aspect ratio at roughly the
 * resolution the photo captured, capped so the long side stays within `maxSide`.
 */
export function rectifiedSize(
  quad: Quad,
  imageWidth: number,
  imageHeight: number,
  maxSide: number,
): { width: number; height: number } {
  const [tl, tr, br, bl] = quad;
  const length = (a: Point, b: Point): number =>
    Math.hypot(b.x - a.x, b.y - a.y);
  const aspect = rectangleAspect(quad, imageWidth, imageHeight);
  const width = Math.max(length(tl, tr), length(bl, br));
  const height = Math.max(length(tl, bl), length(tr, br));
  let size =
    width / height > aspect
      ? { width, height: width / aspect }
      : { width: height * aspect, height };
  const scale = Math.min(1, maxSide / Math.max(size.width, size.height));
  size = { width: size.width * scale, height: size.height * scale };
  return {
    width: Math.max(1, Math.round(size.width)),
    height: Math.max(1, Math.round(size.height)),
  };
}

/** Share of the width and height of an image that a centered crop covers. */
export interface CropFractions {
  width: number;
  height: number;
}

/**
 * The largest centered crop of an image with aspect `imageAspect` that has
 * aspect `cropAspect` (both width/height): it spans the full image one way.
 */
export function cropFractions(
  cropAspect: number,
  imageAspect: number,
): CropFractions {
  const ratio = cropAspect / imageAspect;
  return ratio > 1
    ? { width: 1, height: 1 / ratio }
    : { width: ratio, height: 1 };
}

/** Maps normalized corners from a centered crop to the full image it was cut from. */
export function uncropQuad(quad: Quad, crop: CropFractions): Quad {
  return quad.map((p) => ({
    x: 0.5 + (p.x - 0.5) * crop.width,
    y: 0.5 + (p.y - 0.5) * crop.height,
  })) as Quad;
}
