// PDF document loading on pdfjs-dist: resolves a PDFDocumentProxy for a source URL. The worker source is injectable so the app shell decides asset resolution; a best-effort default resolves the bundled worker.
import { useEffect, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";

export interface PdfDocumentState {
  document: PDFDocumentProxy | null;
  loading: boolean;
  error: string | null;
}

let workerConfigured = false;

/** Injects the pdfjs worker source (call from the app shell with its asset-resolved URL). */
export function setPdfWorkerSrc(url: string): void {
  pdfjsLib.GlobalWorkerOptions.workerSrc = url;
  workerConfigured = true;
}

function ensureWorkerConfigured(): void {
  if (workerConfigured) return;
  workerConfigured = true;
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  } catch {
    // Worker asset resolution failed; the app shell must call setPdfWorkerSrc.
  }
}

const EMPTY_STATE: PdfDocumentState = {
  document: null,
  loading: false,
  error: null,
};
const LOADING_STATE: PdfDocumentState = {
  document: null,
  loading: true,
  error: null,
};

function messageFromError(err: unknown): string {
  return err instanceof Error ? err.message : "Failed to load PDF";
}

/** Loads a PDFDocumentProxy for a source URL; `null`/empty src resolves to an empty state. */
export function usePdfDocument(src?: string | null): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>(EMPTY_STATE);

  useEffect(() => {
    if (!src) {
      setState(EMPTY_STATE);
      return;
    }
    ensureWorkerConfigured();
    let cancelled = false;
    const task = pdfjsLib.getDocument({ url: src });
    setState(LOADING_STATE);
    void (async () => {
      try {
        const pdf = await task.promise;
        if (!cancelled)
          setState({ document: pdf, loading: false, error: null });
      } catch (err) {
        if (!cancelled)
          setState({
            document: null,
            loading: false,
            error: messageFromError(err),
          });
      }
    })();
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [src]);

  return state;
}
