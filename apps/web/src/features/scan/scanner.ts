// Page-side handle to the scanner worker. The worker starts on first use and stays up for the session, because loading OpenCV takes a second or two.
import { analysisBitmap } from "./capture";
import type { Point, Quad } from "./quadGeometry";
import type { ScanJob, ScanRequest, ScanResponse } from "./scanProtocol";

type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./scan.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.addEventListener("message", (event: MessageEvent<ScanResponse>) => {
    const response = event.data;
    const waiting = pending.get(response.id);
    if (!waiting) return;
    pending.delete(response.id);
    if (response.ok) waiting.resolve(response.result);
    else waiting.reject(new Error(response.error));
  });
  worker.addEventListener("error", () => {
    for (const waiting of pending.values())
      waiting.reject(new Error("The scanner stopped"));
    pending.clear();
    worker = null;
  });
  return worker;
}

function send<T>(job: ScanJob, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
    getWorker().postMessage({ ...job, id } satisfies ScanRequest, transfer);
  });
}

/** Starts loading OpenCV; resolves when the scanner is ready. */
export function warmUpScanner(): Promise<void> {
  return send<null>({ type: "warm-up" }).then(() => undefined);
}

/** Corners found in a frame (transferred to the worker), preferring quads around `hint`. */
export function detectFrame(
  frame: ImageBitmap,
  hint?: Point,
): Promise<Quad | null> {
  return send<Quad | null>({ type: "detect", frame, hint }, [frame]);
}

/** Long side of the copy of the reviewed picture that the still is lined up with. */
const VIEW_SIDE = 256;
let nextPhotoKey = 1;

/** A fresh key for a captured photo, unique for the worker's lifetime. */
export function newPhotoKey(): number {
  return nextPhotoKey++;
}

/**
 * Decodes the full-resolution photo in the worker and lines it up with the
 * reviewed `picture`, ready for flattening. Rejects when the photo does not
 * show what the picture shows.
 */
export async function preparePhoto(
  key: number,
  photo: Blob,
  picture: HTMLCanvasElement,
): Promise<{ width: number; height: number }> {
  const view = await analysisBitmap(picture, VIEW_SIDE);
  return send({ type: "prepare", key, photo, view }, [view]);
}

/**
 * The quad (normalized to `picture`) cut out of the full-resolution photo and
 * flattened, as a JPEG. Reuses the work of `preparePhoto` for the same key.
 */
export async function flattenPhoto(
  key: number,
  photo: Blob,
  picture: HTMLCanvasElement,
  quad: Quad,
): Promise<Blob> {
  const view = await analysisBitmap(picture, VIEW_SIDE);
  return send<Blob>({ type: "flatten", key, photo, view, quad }, [view]);
}
