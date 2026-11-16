// Finds the slide, page, or board in a photo and flattens it. Detection proposes quads from edge and brightness contours, joins stacked chalkboard panels, snaps each side to the strongest straight edge near it, and keeps the likeliest quad whose sides all follow real edges.
import type { Mat } from "@techstark/opencv-js";
import type { OpenCv } from "./opencv";
import {
  centroid,
  distanceToLine,
  fitLine,
  insideConvex,
  intersectLines,
  isPlausibleQuad,
  lineThrough,
  orderCorners,
  polygonArea,
  quadFromPolygon,
  rectifiedSize,
  type Line,
  type Point,
  type Quad,
} from "./quadGeometry";

/** RGBA pixels, the shape of `ImageData`. */
export interface PixelImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

const DETECT_SIDE = 512;
const REFINE_SIDE = 1024;
/** Candidates must cover at least this share of the frame. */
const MIN_AREA = 0.03;
/** Polygon vertices this close to the frame edge come from the photo border, not the subject. */
const FRAME_MARGIN = 0.01;
/** Candidates snapped and checked against edges, best first. */
const MAX_VERIFIED = 10;
/** Share of a side that must follow an edge; the rest may be hidden by a person or toolbar. */
const MIN_SIDE_SUPPORT = 0.35;
const MIN_MEAN_SUPPORT = 0.6;
/** Largest brightness difference (0-255) between panels joined into one board. */
const PANEL_GRAY_DIFFERENCE = 30;

interface Candidate {
  quad: Point[];
  area: number;
  score: number;
  /** Built by joining stacked board panels. */
  panels?: boolean;
}

/** 1 at the frame center, falling to 0 near the corners. */
function centrality(quad: readonly Point[]): number {
  const center = centroid(quad);
  return Math.max(0, 1 - Math.hypot(center.x - 0.5, center.y - 0.5) / 0.6);
}

/** Deletes OpenCV matrices once `run` returns, since they live in the WASM heap. */
function withMats<T>(
  run: (track: <M extends { delete(): void }>(mat: M) => M) => T,
): T {
  const mats: { delete(): void }[] = [];
  try {
    return run((mat) => {
      mats.push(mat);
      return mat;
    });
  } finally {
    for (const mat of mats) mat.delete();
  }
}

function toGray(
  cv: OpenCv,
  image: PixelImage,
  maxSide: number,
  track: <M extends { delete(): void }>(m: M) => M,
): Mat {
  const rgba = track(cv.matFromImageData(image as ImageData));
  const gray = track(new cv.Mat());
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  if (scale < 1) {
    cv.resize(
      gray,
      gray,
      new cv.Size(
        Math.round(image.width * scale),
        Math.round(image.height * scale),
      ),
      0,
      0,
      cv.INTER_AREA,
    );
  }
  return gray;
}

/** Quads traced from one binary image, in normalized coordinates. */
function candidatesFrom(cv: OpenCv, binary: Mat): Candidate[] {
  const width = binary.cols;
  const height = binary.rows;
  return withMats((track) => {
    const contours = track(new cv.MatVector());
    const hierarchy = track(new cv.Mat());
    cv.findContours(
      binary,
      contours,
      hierarchy,
      cv.RETR_LIST,
      cv.CHAIN_APPROX_SIMPLE,
    );
    const found: Candidate[] = [];
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = track(contours.get(i));
      if (cv.contourArea(contour) < 0.02 * width * height) continue;
      const hull = track(new cv.Mat());
      const approx = track(new cv.Mat());
      cv.convexHull(contour, hull);
      cv.approxPolyDP(hull, approx, 0.02 * cv.arcLength(hull, true), true);
      const polygon = Array.from({ length: approx.rows }, (_, j) => ({
        x: approx.data32S[j * 2]! / width,
        y: approx.data32S[j * 2 + 1]! / height,
      }));
      const onFrame = polygon.filter(
        (p) =>
          p.x < FRAME_MARGIN ||
          p.y < FRAME_MARGIN ||
          p.x > 1 - FRAME_MARGIN ||
          p.y > 1 - FRAME_MARGIN,
      ).length;
      if (onFrame >= 2) continue;
      const quad = quadFromPolygon(polygon);
      if (
        !quad ||
        !isPlausibleQuad(quad) ||
        quad.some((p) => p.x < -0.05 || p.y < -0.05 || p.x > 1.05 || p.y > 1.05)
      )
        continue;
      const area = polygonArea(quad);
      // The traced shape must mostly fill its quad, or it is not a rectangle.
      const fill = cv.contourArea(hull) / (area * width * height);
      if (area < MIN_AREA || fill < 0.85) continue;
      found.push({ quad, area, score: area * centrality(quad) });
    }
    return found;
  });
}

/** Rough quads from a downscaled frame, ordered TL, TR, BR, BL. */
function roughCandidates(cv: OpenCv, image: PixelImage): Candidate[] {
  const candidates = withMats((track) => {
    const gray = toGray(cv, image, DETECT_SIDE, track);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const edges = track(new cv.Mat());
    cv.Canny(gray, edges, 40, 120);
    const kernel = track(
      cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)),
    );
    cv.dilate(edges, edges, kernel);
    const bright = track(new cv.Mat());
    cv.threshold(gray, bright, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    return [...candidatesFrom(cv, edges), ...candidatesFrom(cv, bright)];
  });
  return candidates.map((c) => ({ ...c, quad: orderCorners(c.quad) }));
}

/** Average brightness inside a quad (normalized corners), sampled on a grid. */
function meanGray(gradient: Gradient, quad: readonly Point[]): number {
  const [tl, tr, br, bl] = quad as Quad;
  const { gray, width, height } = gradient;
  let sum = 0;
  let count = 0;
  for (let i = 1; i < 10; i += 1) {
    for (let j = 1; j < 10; j += 1) {
      const u = i / 10;
      const v = j / 10;
      const x =
        (1 - v) * ((1 - u) * tl.x + u * tr.x) + v * ((1 - u) * bl.x + u * br.x);
      const y =
        (1 - v) * ((1 - u) * tl.y + u * tr.y) + v * ((1 - u) * bl.y + u * br.y);
      const px = Math.min(width - 1, Math.max(0, Math.round(x * width)));
      const py = Math.min(height - 1, Math.max(0, Math.round(y * height)));
      sum += gray[py * width + px]!;
      count += 1;
    }
  }
  return sum / count;
}

/**
 * Chalkboards are often two or three panels stacked in one frame. Adds the
 * whole board for every run of panels where one's bottom edge is the next
 * one's top edge.
 */
function withStackedPanels(
  gradient: Gradient,
  candidates: Candidate[],
): Candidate[] {
  const all = [...candidates];
  for (let i = 0; i < all.length; i += 1) {
    const upper = all[i]!;
    for (const lower of candidates) {
      const [tl, tr, br, bl] = upper.quad as Quad;
      const [ltl, ltr, lbr, lbl] = lower.quad as Quad;
      const width = Math.hypot(br.x - bl.x, br.y - bl.y);
      const near = (a: Point, b: Point): boolean =>
        Math.hypot(a.x - b.x, a.y - b.y) < 0.08 * width;
      if (lower === upper || !near(bl, ltl) || !near(br, ltr)) continue;
      // Panels of one board share a surface; a slide above a board does not.
      if (
        Math.abs(
          meanGray(gradient, upper.quad) - meanGray(gradient, lower.quad),
        ) > PANEL_GRAY_DIFFERENCE
      )
        continue;
      const quad = [tl, tr, lbr, lbl];
      if (!isPlausibleQuad(quad)) continue;
      const area = polygonArea(quad);
      if (all.some((c) => c.panels && Math.abs(c.area - area) < 1e-3)) continue;
      all.push({ quad, area, score: area * centrality(quad), panels: true });
    }
  }
  return all;
}

/**
 * Picks the candidate most likely to be the subject. Each one is first snapped
 * to real edges, and dropped unless all four sides follow an edge for most of
 * their length; this rejects shapes traced around people, walls, and windows.
 */
function pickQuad(gradient: Gradient, candidates: Candidate[]): Quad | null {
  const verified: Candidate[] = [];
  const shortlist = withStackedPanels(gradient, candidates)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_VERIFIED);
  for (const candidate of shortlist) {
    const quad = refineQuad(gradient, candidate.quad as Quad);
    const support = quad.map((a, i) =>
      sideSupport(gradient, a, quad[(i + 1) % 4]!),
    );
    const mean = support.reduce((sum, v) => sum + v, 0) / 4;
    if (Math.min(...support) < MIN_SIDE_SUPPORT || mean < MIN_MEAN_SUPPORT)
      continue;
    const area = polygonArea(quad);
    verified.push({
      ...candidate,
      quad,
      area,
      score: area * centrality(quad) * mean,
    });
  }
  // A quad nested inside a larger one and filling most of it is the content:
  // the slide on a projector screen, or the page on a clipboard. A board made
  // of panels is the exception; the panels are parts of it.
  for (const outer of verified) {
    if (outer.panels) continue;
    // Snapped quads can share an edge, so allow a little slack.
    const middle = centroid(outer.quad);
    const grown = outer.quad.map((p) => ({
      x: middle.x + (p.x - middle.x) * 1.03,
      y: middle.y + (p.y - middle.y) * 1.03,
    }));
    for (const inner of verified) {
      if (
        inner === outer ||
        inner.area >= outer.area ||
        inner.area < 0.5 * outer.area
      )
        continue;
      if (inner.quad.every((p) => insideConvex(p, grown)))
        outer.score = Math.min(outer.score, inner.score * 0.99);
    }
  }
  verified.sort((a, b) => b.score - a.score);
  return (verified[0]?.quad as Quad | undefined) ?? null;
}

interface Gradient {
  /** The grayscale frame the gradient was taken from. */
  gray: Uint8Array;
  gx: Float32Array;
  gy: Float32Array;
  width: number;
  height: number;
}

interface EdgePeak extends Point {
  station: number;
  /** Closer to the rough side weighs more, so a parallel frame edge loses. */
  weight: number;
}

const STATIONS = 60;
const MIN_SUPPORT = 12;
/** Half-width in pixels of the strip along a side where an edge counts as support. */
const SUPPORT_BAND = 3;

/** Local maxima of the edge strength across the side, sampled at evenly spaced stations. */
function edgePeaks(
  gradient: Gradient,
  a: Point,
  b: Point,
  band: number,
): EdgePeak[] {
  const { gx, gy, width, height } = gradient;
  const { d } = lineThrough(a, b);
  const n = { x: -d.y, y: d.x };
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const reach = Math.ceil(band);
  const peaks: EdgePeak[] = [];
  for (let station = 1; station < STATIONS; station += 1) {
    const t = (station / STATIONS) * length;
    const profile: ({
      x: number;
      y: number;
      offset: number;
      strength: number;
    } | null)[] = [];
    for (let offset = -reach; offset <= reach; offset += 1) {
      const x = Math.round(a.x + d.x * t + n.x * offset);
      const y = Math.round(a.y + d.y * t + n.y * offset);
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) {
        profile.push(null);
        continue;
      }
      const k = y * width + x;
      const across = Math.abs(gx[k]! * n.x + gy[k]! * n.y);
      const along = Math.abs(gx[k]! * d.x + gy[k]! * d.y);
      // Only edges running parallel to the side count.
      profile.push({ x, y, offset, strength: across > 2 * along ? across : 0 });
    }
    for (let j = 1; j < profile.length - 1; j += 1) {
      const here = profile[j];
      if (!here || here.strength < 30) continue;
      if ((profile[j - 1]?.strength ?? 0) > here.strength) continue;
      if ((profile[j + 1]?.strength ?? 0) >= here.strength) continue;
      peaks.push({
        x: here.x,
        y: here.y,
        station,
        weight: Math.exp(-((here.offset / (band / 2)) ** 2)),
      });
    }
  }
  return peaks;
}

/** RANSAC over edge peaks with a fixed seed, so results are repeatable. */
function strongestLine(
  peaks: readonly EdgePeak[],
  tolerance: number,
): { line: Line; support: number } | null {
  let state = 1;
  const random = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  let best: Line | null = null;
  let bestScore = 0;
  for (let attempt = 0; attempt < 300 && peaks.length >= 2; attempt += 1) {
    const p = peaks[Math.floor(random() * peaks.length)]!;
    const q = peaks[Math.floor(random() * peaks.length)]!;
    if (Math.abs(p.station - q.station) < 3) continue;
    const line = lineThrough(p, q);
    // Count each station once so a cluttered patch cannot outvote a long edge.
    const byStation = new Map<number, number>();
    for (const peak of peaks) {
      if (distanceToLine(line, peak) <= tolerance)
        byStation.set(
          peak.station,
          Math.max(byStation.get(peak.station) ?? 0, peak.weight),
        );
    }
    let score = 0;
    for (const weight of byStation.values()) score += weight;
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
  }
  if (!best) return null;
  const line = best;
  const inliers = peaks.filter(
    (peak) => distanceToLine(line, peak) <= tolerance,
  );
  return {
    line: fitLine(inliers),
    support: new Set(inliers.map((peak) => peak.station)).size,
  };
}

function projectOnto(line: Line, p: Point): Point {
  const t = (p.x - line.p.x) * line.d.x + (p.y - line.p.y) * line.d.y;
  return { x: line.p.x + t * line.d.x, y: line.p.y + t * line.d.y };
}

/**
 * Snaps one side to a real edge: a wide search finds the best-supported line,
 * then a tight pass along that line picks up the stretch the rough side missed,
 * such as where a toolbar covers the corner.
 */
function snapSide(gradient: Gradient, a: Point, b: Point): Line {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const coarse = strongestLine(
    edgePeaks(gradient, a, b, Math.max(6, 0.1 * length)),
    1.5,
  );
  if (!coarse || coarse.support < MIN_SUPPORT) return lineThrough(a, b);
  const fine = strongestLine(
    edgePeaks(
      gradient,
      projectOnto(coarse.line, a),
      projectOnto(coarse.line, b),
      3,
    ),
    1,
  );
  return fine && fine.support >= MIN_SUPPORT ? fine.line : coarse.line;
}

/** Edge strength of the frame at analysis resolution. */
function gradientOf(cv: OpenCv, image: PixelImage): Gradient {
  return withMats((track) => {
    const gray = toGray(cv, image, REFINE_SIDE, track);
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
    const gx = track(new cv.Mat());
    const gy = track(new cv.Mat());
    cv.Sobel(gray, gx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(gray, gy, cv.CV_32F, 0, 1, 3);
    // Copy out of the WASM heap, since the matrices are freed on return.
    return {
      gray: gray.data.slice(),
      gx: gx.data32F.slice(),
      gy: gy.data32F.slice(),
      width: gray.cols,
      height: gray.rows,
    };
  });
}

/** Share of a side (normalized corners) that runs along an edge in the frame. */
function sideSupport(gradient: Gradient, from: Point, to: Point): number {
  const a = { x: from.x * gradient.width, y: from.y * gradient.height };
  const b = { x: to.x * gradient.width, y: to.y * gradient.height };
  const stations = new Set(
    edgePeaks(gradient, a, b, SUPPORT_BAND).map((peak) => peak.station),
  );
  return stations.size / (STATIONS - 1);
}

/** Snaps each side of a rough quad (normalized corners) to the strongest straight edge near it. */
function refineQuad(gradient: Gradient, rough: Quad): Quad {
  const { width, height } = gradient;
  const corners = rough.map((p) => ({ x: p.x * width, y: p.y * height }));
  const sides = corners.map((a, i) =>
    snapSide(gradient, a, corners[(i + 1) % 4]!),
  );
  const refined: Point[] = [];
  for (let i = 0; i < 4; i += 1) {
    const corner = intersectLines(sides[(i + 3) % 4]!, sides[i]!);
    if (!corner) return rough;
    refined.push({ x: corner.x / width, y: corner.y / height });
  }
  // Snapping nudges corners; a big jump means it locked onto something else.
  const moved = Math.max(
    ...refined.map((p, i) => Math.hypot(p.x - rough[i]!.x, p.y - rough[i]!.y)),
  );
  return moved < 0.1 && isPlausibleQuad(refined)
    ? orderCorners(refined)
    : rough;
}

/** The document's corners in normalized [0, 1] coordinates, ordered TL, TR, BR, BL. */
export function detectDocument(cv: OpenCv, image: PixelImage): Quad | null {
  const candidates = roughCandidates(cv, image);
  return candidates.length > 0
    ? pickQuad(gradientOf(cv, image), candidates)
    : null;
}

/** Warps the quad (normalized corners) to a flat, upright image at its true aspect ratio. */
export function flattenDocument(
  cv: OpenCv,
  image: PixelImage,
  quad: Quad,
  maxSide: number,
): PixelImage {
  const corners = orderCorners(
    quad.map((p) => ({ x: p.x * image.width, y: p.y * image.height })),
  );
  const size = rectifiedSize(corners, image.width, image.height, maxSide);
  return withMats((track) => {
    const source = track(cv.matFromImageData(image as ImageData));
    const output = track(new cv.Mat());
    const from = track(
      cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        corners.flatMap((p) => [p.x, p.y]),
      ),
    );
    const to = track(
      cv.matFromArray(4, 1, cv.CV_32FC2, [
        0,
        0,
        size.width,
        0,
        size.width,
        size.height,
        0,
        size.height,
      ]),
    );
    const transform = track(cv.getPerspectiveTransform(from, to));
    cv.warpPerspective(
      source,
      output,
      transform,
      new cv.Size(size.width, size.height),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
    );
    return {
      data: new Uint8ClampedArray(output.data),
      width: size.width,
      height: size.height,
    };
  });
}
