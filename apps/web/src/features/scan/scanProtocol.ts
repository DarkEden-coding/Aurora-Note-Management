// Messages between the page and the scanner worker.
import type { Point, Quad } from "./quadGeometry";

export type ScanJob =
  | { type: "warm-up" }
  /** Pixels are read in the worker, so the page never waits on a GPU readback. */
  | { type: "detect"; frame: ImageBitmap; hint?: Point | undefined }
  /**
   * `quad` is normalized to a view with `viewAspect` (width/height), such as
   * the video frame shown at capture; the photo may be a wider still.
   */
  | { type: "flatten"; photo: Blob; quad: Quad; viewAspect: number };

export type ScanRequest = ScanJob & { id: number };

export type ScanResponse =
  | { id: number; ok: true; result: Quad | Blob | null }
  | { id: number; ok: false; error: string };
