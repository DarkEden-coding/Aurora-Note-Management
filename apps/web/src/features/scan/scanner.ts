// Page-side handle to the scanner worker. The worker starts on first use and stays up for the session, because loading OpenCV takes a second or two.
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

/**
 * The quad cut out of the full-resolution photo and flattened, as a JPEG.
 * `quad` is normalized to a view with aspect `viewAspect`, which may be a
 * center crop of the photo.
 */
export function flattenPhoto(
  photo: Blob,
  quad: Quad,
  viewAspect: number,
): Promise<Blob> {
  return send<Blob>({ type: "flatten", photo, quad, viewAspect });
}
