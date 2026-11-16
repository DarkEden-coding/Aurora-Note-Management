// Messages between the page and the scanner worker.
import type { Point, Quad } from "./quadGeometry";

export type ScanJob =
  | { type: "warm-up" }
  /** Pixels are read in the worker, so the page never waits on a GPU readback. */
  | { type: "detect"; frame: ImageBitmap; hint?: Point | undefined }
  /**
   * Decodes a full-resolution photo and lines it up with `view`, a small copy
   * of the picture the user reviews; kept under `key` for the flatten.
   */
  | { type: "prepare"; key: number; photo: Blob; view: ImageBitmap }
  /** `quad` is normalized to the view; the photo may be turned or wider. */
  | {
      type: "flatten";
      key: number;
      photo: Blob;
      view: ImageBitmap;
      quad: Quad;
    };

export type ScanRequest = ScanJob & { id: number };

export type ScanResult = Quad | Blob | { width: number; height: number } | null;

export type ScanResponse =
  | { id: number; ok: true; result: ScanResult }
  | { id: number; ok: false; error: string };
