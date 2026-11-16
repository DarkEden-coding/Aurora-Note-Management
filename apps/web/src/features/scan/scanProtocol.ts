// Messages between the page and the scanner worker.
import type { PixelImage } from "./detectDocument";
import type { Quad } from "./quadGeometry";

export type ScanJob =
  | { type: "warm-up" }
  | { type: "detect-frame"; frame: PixelImage }
  | { type: "detect-photo"; photo: Blob }
  | { type: "flatten"; photo: Blob; quad: Quad };

export type ScanRequest = ScanJob & { id: number };

export type ScanResponse =
  | { id: number; ok: true; result: Quad | Blob | null }
  | { id: number; ok: false; error: string };
