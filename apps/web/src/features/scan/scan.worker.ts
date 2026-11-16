// Scanner worker: runs OpenCV off the main thread so the viewfinder stays smooth. It loads OpenCV on first use, detects documents in preview frames and photos, and flattens photos to JPEG.
import opencvUrl from "@techstark/opencv-js/dist/opencv.js?url";
import {
  detectDocument,
  flattenDocument,
  type PixelImage,
} from "./detectDocument";
import { whenOpenCvReady, type OpenCv } from "./opencv";
import type { Quad } from "./quadGeometry";
import type { ScanRequest, ScanResponse } from "./scanProtocol";

/** Photos are analyzed at this size; the detector downsizes further itself. */
const ANALYSIS_SIDE = 1024;
const OUTPUT_MAX_SIDE = 4096;
const OUTPUT_QUALITY = 0.92;

let opencv: Promise<OpenCv> | null = null;

/**
 * OpenCV ships as a UMD script. Module workers cannot `importScripts`, and
 * importing it as a module hangs on its `then` export, so evaluate it with a
 * CommonJS `module` shim, which is the branch its UMD wrapper takes.
 */
function loadOpenCv(): Promise<OpenCv> {
  opencv ??= fetch(opencvUrl)
    .then((response) => {
      if (!response.ok)
        throw new Error(`Could not load the scanner (${response.status})`);
      return response.text();
    })
    .then((source) => {
      const shim: { exports: unknown } = { exports: {} };
      new Function("module", "exports", source)(shim, shim.exports);
      return whenOpenCvReady(shim.exports);
    });
  opencv.catch(() => {
    opencv = null;
  });
  return opencv;
}

async function decode(photo: Blob, maxSide: number): Promise<PixelImage> {
  const bitmap = await createImageBitmap(photo, {
    imageOrientation: "from-image",
  });
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } finally {
    bitmap.close();
  }
}

async function toJpeg(image: PixelImage): Promise<Blob> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas
    .getContext("2d")!
    .putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas.convertToBlob({ type: "image/jpeg", quality: OUTPUT_QUALITY });
}

async function handle(request: ScanRequest): Promise<Quad | Blob | null> {
  const cv = await loadOpenCv();
  switch (request.type) {
    case "warm-up":
      return null;
    case "detect-frame":
      return detectDocument(cv, request.frame);
    case "detect-photo":
      return detectDocument(cv, await decode(request.photo, ANALYSIS_SIDE));
    case "flatten": {
      const photo = await decode(request.photo, Number.POSITIVE_INFINITY);
      return toJpeg(flattenDocument(cv, photo, request.quad, OUTPUT_MAX_SIDE));
    }
  }
}

self.addEventListener("message", (event: MessageEvent<ScanRequest>) => {
  const request = event.data;
  handle(request).then(
    (result) =>
      self.postMessage({
        id: request.id,
        ok: true,
        result,
      } satisfies ScanResponse),
    (error: unknown) =>
      self.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : "Scanning failed",
      } satisfies ScanResponse),
  );
});
