// A captured picture on its way to review: what the user saw, shown at once, and the full-resolution photo that may still be arriving.
import type { Point, Quad } from "./quadGeometry";

export interface Capture {
  /** The picture shown for review, available immediately. */
  picture: HTMLCanvasElement;
  /** The full-resolution photo to flatten; a camera still can take a second to arrive. */
  photo: Promise<Blob>;
  /** The live outline at the shutter, shown until detection on the picture finishes. */
  outline: Quad | null;
  /** The spot the user tapped in the viewfinder, if any. */
  hint: Point | null;
}

/** Longest side of a picture decoded from a file for review. */
const PICTURE_MAX_SIDE = 2048;

export function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Could not save the photo")),
      "image/jpeg",
      0.95,
    ),
  );
}

/** A photo from the camera app or the library, ready for review. */
export async function captureFromFile(file: Blob): Promise<Capture> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const scale = Math.min(
      1,
      PICTURE_MAX_SIDE / Math.max(bitmap.width, bitmap.height),
    );
    const picture = document.createElement("canvas");
    picture.width = Math.round(bitmap.width * scale);
    picture.height = Math.round(bitmap.height * scale);
    picture
      .getContext("2d")!
      .drawImage(bitmap, 0, 0, picture.width, picture.height);
    return { picture, photo: Promise.resolve(file), outline: null, hint: null };
  } finally {
    bitmap.close();
  }
}

/** A downscaled copy for the detector, made without reading pixels on this thread. */
export async function analysisBitmap(
  source: HTMLVideoElement | HTMLCanvasElement,
  maxSide: number,
): Promise<ImageBitmap> {
  const width =
    source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const height =
    source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const size = {
    resizeWidth: Math.max(1, Math.round(width * scale)),
    resizeHeight: Math.max(1, Math.round(height * scale)),
  };
  try {
    return await createImageBitmap(source, {
      ...size,
      resizeQuality: "low",
    });
  } catch {
    // Older Safari rejects resize options; scale on a canvas instead.
    const canvas = document.createElement("canvas");
    canvas.width = size.resizeWidth;
    canvas.height = size.resizeHeight;
    canvas
      .getContext("2d")!
      .drawImage(source, 0, 0, canvas.width, canvas.height);
    return createImageBitmap(canvas);
  }
}
