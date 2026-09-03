// PDF page renderer: draws one document page to a canvas at display resolution. Pages render lazily only while mounted and visible.
import { type ReactNode, useEffect, useRef } from "react";
import { usePdfDocument } from "./usePdfDocument";

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

export function PdfPageView({
  pdfUrl,
  pageNumber = 0,
  targetWidth = 480,
  className,
  onRendered,
}: PdfPageViewProps): ReactNode {
  const { document: pdf, loading, error } = usePdfDocument(pdfUrl ?? null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onRenderedRef = useRef(onRendered);
  onRenderedRef.current = onRendered;

  useEffect(() => {
    if (!pdf || pageNumber < 0 || pageNumber >= pdf.numPages) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber + 1);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const base = page.getViewport({ scale: 1 });
        const dpr =
          typeof window !== "undefined" && window.devicePixelRatio > 0
            ? window.devicePixelRatio
            : 1;
        const viewport = page.getViewport({
          scale: (targetWidth / base.width) * dpr,
        });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const context = canvas.getContext("2d");
        if (!context) return;
        // pdfjs 6 takes the canvas element itself; the 2D context is implied.
        const task = page.render({ canvas, viewport });
        void task.promise.catch(() => {
          // Cancelled or failed renders surface as placeholder.
        });
        onRenderedRef.current?.({
          pageNumber,
          width: viewport.width / dpr,
          height: viewport.height / dpr,
        });
      } catch {
        // Page render failures surface as placeholder.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber, targetWidth]);

  const outOfRange =
    pdf !== null && (pageNumber < 0 || pageNumber >= pdf.numPages);

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
      {error === null && !outOfRange && (loading || pdf === null) ? (
        <div className="pdf-page-view-placeholder">Loading page…</div>
      ) : null}
    </div>
  );
}
