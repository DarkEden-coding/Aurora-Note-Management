// PDF page renderer: paints one document page to a canvas at display resolution. Renders come from a shared page cache, so a page shown once repaints instantly on remount, and the following pages are prefetched in the background.
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { usePdfDocument } from "./usePdfDocument";
import {
  getRenderedPage,
  pageCacheKey,
  prefetchPages,
  renderPage,
  type RenderedPage,
} from "./pageCache";

/** Pages after the current one to warm in the background. */
const PREFETCH_AHEAD = 2;

export interface PdfPageViewProps {
  /** Source PDF URL; omitted sources render a placeholder. */
  pdfUrl?: string | undefined;
  /** Zero-based page index. */
  pageNumber?: number | undefined;
  /** Display width in screen pixels. */
  targetWidth?: number | undefined;
  className?: string | undefined;
  onRendered?:
    | ((info: { pageNumber: number; width: number; height: number }) => void)
    | undefined;
}

function devicePixelRatio(): number {
  // Capped at 2: sharper renders cost memory quadratically for little visible gain.
  return typeof window !== "undefined" && window.devicePixelRatio > 0
    ? Math.min(2, window.devicePixelRatio)
    : 1;
}

function paint(canvas: HTMLCanvasElement, page: RenderedPage): void {
  if (
    canvas.width !== page.bitmap.width ||
    canvas.height !== page.bitmap.height
  ) {
    canvas.width = page.bitmap.width;
    canvas.height = page.bitmap.height;
  }
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(page.bitmap, 0, 0);
}

export function PdfPageView({
  pdfUrl,
  pageNumber = 0,
  targetWidth = 480,
  className,
  onRendered,
}: PdfPageViewProps): ReactNode {
  const src = pdfUrl ?? null;
  const { document: pdf, loading, error } = usePdfDocument(src);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;
  const [renderedKey, setRenderedKey] = useState<string | null>(null);
  const [renderError, setRenderError] = useState(false);

  const dpr = devicePixelRatio();
  const key =
    src !== null ? pageCacheKey(src, pageNumber, targetWidth, dpr) : null;
  const inRange = pdf !== null && pageNumber >= 0 && pageNumber < pdf.numPages;

  // Cached pages paint before the browser shows the frame, so remounts never flash.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (key === null || canvas === null) return;
    const cached = getRenderedPage(key);
    if (cached === null) return;
    paint(canvas, cached);
    canvas.dataset.pdfRenderedKey = key;
    canvas.dataset.pdfRendered = "true";
    setRenderedKey(key);
  }, [key]);

  useEffect(() => {
    if (!pdf || src === null || key === null || !inRange) return;
    let cancelled = false;
    setRenderError(false);
    const finish = (page: RenderedPage): void => {
      const canvas = canvasRef.current;
      if (cancelled || canvas === null) return;
      if (canvas.dataset.pdfRenderedKey !== key) {
        paint(canvas, page);
        canvas.dataset.pdfRenderedKey = key;
      }
      canvas.dataset.pdfRendered = "true";
      setRenderedKey(key);
      onRenderedRef.current?.({
        pageNumber,
        width: page.width,
        height: page.height,
      });
      prefetchPages(
        pdf,
        src,
        Array.from({ length: PREFETCH_AHEAD }, (_, i) => pageNumber + i + 1),
        targetWidth,
        dpr,
      );
    };
    const cached = getRenderedPage(key);
    if (cached !== null) {
      finish(cached);
    } else {
      // A render that outlives this view still lands in the cache for the next mount.
      renderPage(pdf, src, pageNumber, targetWidth, dpr, "visible").then(
        finish,
        () => {
          if (!cancelled) setRenderError(true);
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [pdf, src, key, inRange, pageNumber, targetWidth, dpr]);

  const outOfRange =
    pdf !== null && (pageNumber < 0 || pageNumber >= pdf.numPages);
  const rendered = renderedKey !== null && renderedKey === key;

  return (
    <div className={`pdf-page-view ${className ?? ""}`}>
      <canvas ref={canvasRef} className="pdf-page-view-canvas" />
      {error !== null ? (
        <div className="pdf-page-view-error">{error}</div>
      ) : null}
      {error === null && outOfRange ? (
        <div className="pdf-page-view-error">
          Page {pageNumber + 1} not in document
        </div>
      ) : null}
      {error === null && renderError ? (
        <div className="pdf-page-view-error">Could not render page</div>
      ) : null}
      {error === null &&
      !outOfRange &&
      !renderError &&
      !rendered &&
      (loading || pdf === null || inRange) ? (
        <div className="pdf-page-view-placeholder">Loading page…</div>
      ) : null}
    </div>
  );
}
