// Lines a full-resolution still up with the preview frame the user saw. A camera still can come back turned, or wider than the preview when zoom or the stream's aspect differ, so this finds the turn and centered crop of the still that best matches the frame.
import type { PixelImage } from "./detectDocument";
import { cropFractions, type CropFractions } from "./quadGeometry";

export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

/** Quarter turns clockwise. */
export type Turns = 0 | 1 | 2 | 3;

export interface Alignment {
  /** Turn the still this many quarter turns clockwise first. */
  turns: Turns;
  /** Then the preview is this centered crop of the turned still. */
  crop: CropFractions;
  /** Normalized cross-correlation of the match, from -1 to 1. */
  score: number;
}

/** Long side of the grid the two images are compared on. */
const GRID_SIDE = 64;
/** Crop scales tried below the aspect-only crop; down to 0.25 covers 4× zoom. */
const SCALES = Array.from({ length: 16 }, (_, i) => 1 - i * 0.05);

export function toGray(image: PixelImage): Gray {
  const data = new Float32Array(image.width * image.height);
  for (let i = 0; i < data.length; i += 1) {
    const k = i * 4;
    data[i] =
      0.299 * image.data[k]! +
      0.587 * image.data[k + 1]! +
      0.114 * image.data[k + 2]!;
  }
  return { data, width: image.width, height: image.height };
}

/** Rotates by quarter turns clockwise. */
export function rotateGray(image: Gray, turns: Turns): Gray {
  if (turns === 0) return image;
  const { data, width, height } = image;
  const odd = turns % 2 === 1;
  const out = {
    data: new Float32Array(data.length),
    width: odd ? height : width,
    height: odd ? width : height,
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [nx, ny] =
        turns === 1
          ? [height - 1 - y, x]
          : turns === 2
            ? [width - 1 - x, height - 1 - y]
            : [y, width - 1 - x];
      out.data[ny * out.width + nx] = data[y * width + x]!;
    }
  }
  return out;
}

/** Box blur, so sampling a coarse grid does not alias on fine detail. */
function blur(image: Gray, radius: number): Gray {
  const { width, height } = image;
  const pass = (source: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(source.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let count = 0;
        for (let d = -radius; d <= radius; d += 1) {
          const sx = horizontal ? x + d : x;
          const sy = horizontal ? y : y + d;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          sum += source[sy * width + sx]!;
          count += 1;
        }
        out[y * width + x] = sum / count;
      }
    }
    return out;
  };
  return { data: pass(pass(image.data, true), false), width, height };
}

function sample(image: Gray, x: number, y: number): number {
  const cx = Math.min(image.width - 1, Math.max(0, x));
  const cy = Math.min(image.height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const at = (px: number, py: number): number =>
    image.data[py * image.width + px]!;
  return (
    (1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x1, y0)) +
    fy * ((1 - fx) * at(x0, y1) + fx * at(x1, y1))
  );
}

/** The centered crop of `image` resampled onto a grid of the given size. */
function cropGrid(
  image: Gray,
  crop: CropFractions,
  columns: number,
  rows: number,
): Float32Array {
  const grid = new Float32Array(columns * rows);
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < columns; i += 1) {
      const u = 0.5 + ((i + 0.5) / columns - 0.5) * crop.width;
      const v = 0.5 + ((j + 0.5) / rows - 0.5) * crop.height;
      grid[j * columns + i] = sample(
        image,
        u * image.width - 0.5,
        v * image.height - 0.5,
      );
    }
  }
  return grid;
}

function correlation(a: Float32Array, b: Float32Array): number {
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < a.length; i += 1) {
    meanA += a[i]!;
    meanB += b[i]!;
  }
  meanA /= a.length;
  meanB /= b.length;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * Finds how `still` was turned and cropped relative to `view`. Both should be
 * small (a few hundred pixels); only their content and aspect matter.
 */
export function alignToView(still: Gray, view: Gray): Alignment {
  const viewAspect = view.width / view.height;
  const columns = Math.max(
    8,
    Math.round(viewAspect >= 1 ? GRID_SIDE : GRID_SIDE * viewAspect),
  );
  const rows = Math.max(
    8,
    Math.round(viewAspect >= 1 ? GRID_SIDE / viewAspect : GRID_SIDE),
  );
  const radius = (image: Gray): number =>
    Math.max(
      0,
      Math.round(Math.max(image.width, image.height) / GRID_SIDE / 2),
    );
  const target = cropGrid(
    blur(view, radius(view)),
    { width: 1, height: 1 },
    columns,
    rows,
  );
  const blurred = blur(still, radius(still));
  let best: Alignment = {
    turns: 0,
    crop: { width: 1, height: 1 },
    score: -Infinity,
  };
  for (const turns of [0, 1, 2, 3] as const) {
    const turned = rotateGray(blurred, turns);
    const base = cropFractions(viewAspect, turned.width / turned.height);
    for (const scale of SCALES) {
      const crop = { width: base.width * scale, height: base.height * scale };
      const score = correlation(cropGrid(turned, crop, columns, rows), target);
      if (score > best.score) best = { turns, crop, score };
    }
  }
  return best;
}
