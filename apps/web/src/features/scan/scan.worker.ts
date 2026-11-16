// Scanner worker: runs OpenCV off the main thread so the viewfinder stays smooth. It loads OpenCV on first use, detects documents in frames, and flattens photos to JPEG.
import opencvUrl from "@techstark/opencv-js/dist/opencv.js?url";
import {
  detectDocument,
  flattenDocument,
  type PixelImage,
} from "./detectDocument";
import { whenOpenCvReady, type OpenCv } from "./opencv";
import { alignToView, toGray, type Turns } from "./alignPhoto";
import { uncropQuad, type CropFractions } from "./quadGeometry";
import type { ScanRequest, ScanResponse, ScanResult } from "./scanProtocol";

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

/** Long side of the copies compared when lining the still up with the preview. */
const ALIGN_SIDE = 256;
/** Below this match the still shows something else, and the preview frame is used. */
const MIN_MATCH = 0.6;

/** The bitmap's pixels, turned clockwise by quarter turns and scaled to fit `maxSide`. */
function drawn(bitmap: ImageBitmap, turns: Turns, maxSide: number): PixelImage {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const odd = turns % 2 === 1;
  const canvas = new OffscreenCanvas(
    odd ? height : width,
    odd ? width : height,
  );
  const context = canvas.getContext("2d")!;
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((turns * Math.PI) / 2);
  context.drawImage(bitmap, -width / 2, -height / 2, width, height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

interface PreparedPhoto {
  /** Full resolution, turned to match the preview. */
  image: PixelImage;
  /** The preview's place in `image`. */
  crop: CropFractions;
}

/** The last prepared photo; a capture is prepared while its corners are reviewed, then flattened. */
let prepared: { key: number; photo: Promise<PreparedPhoto> } | null = null;

async function preparePhoto(
  photo: Blob,
  view: ImageBitmap,
): Promise<PreparedPhoto> {
  const viewGray = toGray(pixelsOf(view));
  const bitmap = await createImageBitmap(photo, {
    imageOrientation: "from-image",
  });
  try {
    const alignment = alignToView(
      toGray(drawn(bitmap, 0, ALIGN_SIDE)),
      viewGray,
    );
    if (alignment.score < MIN_MATCH)
      throw new Error("The photo does not match the preview");
    return {
      image: drawn(bitmap, alignment.turns, Number.POSITIVE_INFINITY),
      crop: alignment.crop,
    };
  } finally {
    bitmap.close();
  }
}

function prepare(
  key: number,
  photo: Blob,
  view: ImageBitmap,
): Promise<PreparedPhoto> {
  if (prepared?.key === key) {
    view.close();
    return prepared.photo;
  }
  const entry = { key, photo: preparePhoto(photo, view) };
  // Drop the previous photo first; full-resolution pixels are large.
  prepared = entry;
  entry.photo.catch(() => {
    if (prepared === entry) prepared = null;
  });
  return entry.photo;
}

function pixelsOf(frame: ImageBitmap): PixelImage {
  try {
    const canvas = new OffscreenCanvas(frame.width, frame.height);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(frame, 0, 0);
    return context.getImageData(0, 0, frame.width, frame.height);
  } finally {
    frame.close();
  }
}

async function toJpeg(image: PixelImage): Promise<Blob> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas
    .getContext("2d")!
    .putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas.convertToBlob({ type: "image/jpeg", quality: OUTPUT_QUALITY });
}

async function handle(request: ScanRequest): Promise<ScanResult> {
  const cv = await loadOpenCv();
  switch (request.type) {
    case "warm-up":
      return null;
    case "detect":
      return detectDocument(cv, pixelsOf(request.frame), request.hint);
    case "prepare": {
      const { image } = await prepare(request.key, request.photo, request.view);
      return { width: image.width, height: image.height };
    }
    case "flatten": {
      const { image, crop } = await prepare(
        request.key,
        request.photo,
        request.view,
      );
      const quad = uncropQuad(request.quad, crop);
      return toJpeg(flattenDocument(cv, image, quad, OUTPUT_MAX_SIDE));
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
