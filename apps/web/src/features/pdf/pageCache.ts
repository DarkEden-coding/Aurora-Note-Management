// Rendered PDF page cache: pages render once per (source, page, size) into an ImageBitmap kept in a pixel-budgeted LRU, so remounting a page paints instantly. Renders run through a small prioritized queue so visible pages always beat prefetches.
import type { PDFDocumentProxy } from "pdfjs-dist";

/** Pixel budget for cached bitmaps (~4 bytes each), sized to stay well under mobile canvas limits. */
const MAX_CACHED_PIXELS = 64_000_000;
/** Concurrent renders; pdf.js serializes work in its worker, so more only adds memory pressure. */
const MAX_ACTIVE_RENDERS = 2;

export interface RenderedPage {
  bitmap: ImageBitmap;
  /** CSS-pixel size of the rendered page. */
  width: number;
  height: number;
}

export type RenderPriority = "visible" | "prefetch";

interface QueuedRender {
  key: string;
  priority: RenderPriority;
  run: () => Promise<RenderedPage>;
  resolve: (page: RenderedPage) => void;
  reject: (err: unknown) => void;
}

const cache = new Map<string, RenderedPage>();
let cachedPixels = 0;
const inFlight = new Map<string, Promise<RenderedPage>>();
const queue: QueuedRender[] = [];
let activeRenders = 0;

export function pageCacheKey(
  src: string,
  pageIndex: number,
  cssWidth: number,
  dpr: number,
): string {
  return `${src}\u0000${pageIndex}\u0000${Math.round(cssWidth)}\u0000${dpr}`;
}

/** Returns a cached render and marks it most recently used. */
export function getRenderedPage(key: string): RenderedPage | null {
  const page = cache.get(key);
  if (page === undefined) return null;
  cache.delete(key);
  cache.set(key, page);
  return page;
}

function storeRenderedPage(key: string, page: RenderedPage): void {
  const existing = cache.get(key);
  if (existing !== undefined) {
    cachedPixels -= existing.bitmap.width * existing.bitmap.height;
    cache.delete(key);
    if (existing.bitmap !== page.bitmap) existing.bitmap.close();
  }
  cache.set(key, page);
  cachedPixels += page.bitmap.width * page.bitmap.height;
  for (const [oldKey, old] of cache) {
    if (cachedPixels <= MAX_CACHED_PIXELS || oldKey === key) break;
    cache.delete(oldKey);
    cachedPixels -= old.bitmap.width * old.bitmap.height;
    old.bitmap.close();
  }
}

/** Drops every cached render of a source (called when its document is destroyed). */
export function forgetRenderedPages(src: string): void {
  const prefix = `${src}\u0000`;
  for (const [key, page] of cache) {
    if (!key.startsWith(prefix)) continue;
    cache.delete(key);
    cachedPixels -= page.bitmap.width * page.bitmap.height;
    page.bitmap.close();
  }
}

function pump(): void {
  while (activeRenders < MAX_ACTIVE_RENDERS && queue.length > 0) {
    const index = queue.findIndex((job) => job.priority === "visible");
    const [job] = queue.splice(index === -1 ? 0 : index, 1);
    if (job === undefined) return;
    activeRenders += 1;
    job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        activeRenders -= 1;
        pump();
      });
  }
}

async function renderToBitmap(
  pdf: PDFDocumentProxy,
  pageIndex: number,
  cssWidth: number,
  dpr: number,
): Promise<RenderedPage> {
  const page = await pdf.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  try {
    // pdfjs 6 takes the canvas element itself; the 2D context is implied.
    await page.render({ canvas, viewport }).promise;
    const bitmap = await createImageBitmap(canvas);
    return {
      bitmap,
      width: viewport.width / dpr,
      height: viewport.height / dpr,
    };
  } finally {
    // Release the scratch canvas backing store immediately (iOS caps total canvas memory).
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
  }
}

/**
 * Renders (or reuses) one page at a CSS width and device pixel ratio. Concurrent requests for
 * the same key share one render; a visible request promotes a queued prefetch.
 */
export function renderPage(
  pdf: PDFDocumentProxy,
  src: string,
  pageIndex: number,
  cssWidth: number,
  dpr: number,
  priority: RenderPriority,
): Promise<RenderedPage> {
  const key = pageCacheKey(src, pageIndex, cssWidth, dpr);
  const cached = getRenderedPage(key);
  if (cached !== null) return Promise.resolve(cached);
  const pending = inFlight.get(key);
  if (pending !== undefined) {
    if (priority === "visible") {
      const queued = queue.find((job) => job.key === key);
      if (queued !== undefined) queued.priority = "visible";
    }
    return pending;
  }
  const promise = new Promise<RenderedPage>((resolve, reject) => {
    queue.push({
      key,
      priority,
      run: () => renderToBitmap(pdf, pageIndex, cssWidth, dpr),
      resolve,
      reject,
    });
    pump();
  })
    .then((page) => {
      storeRenderedPage(key, page);
      return page;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

/** Warms the cache for nearby pages without blocking visible renders. */
export function prefetchPages(
  pdf: PDFDocumentProxy,
  src: string,
  pageIndexes: number[],
  cssWidth: number,
  dpr: number,
): void {
  for (const pageIndex of pageIndexes) {
    if (pageIndex < 0 || pageIndex >= pdf.numPages) continue;
    renderPage(pdf, src, pageIndex, cssWidth, dpr, "prefetch").catch(() => {
      // Prefetch failures are retried when the page is actually shown.
    });
  }
}
