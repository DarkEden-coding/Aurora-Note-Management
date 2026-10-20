// PDF document loading on pdfjs-dist: resolves a shared PDFDocumentProxy per source URL. Documents are reference-counted so every page view of one PDF reuses a single load, and idle documents linger briefly so scrolling back does not refetch. The worker source is injectable so the app shell decides asset resolution; a best-effort default resolves the bundled worker.
import { useEffect, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { forgetRenderedPages } from "./pageCache";

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

/** Loads a local PDF so callers can inspect its pages before uploading it. */
export async function loadPdfFile(file: File): Promise<PDFDocumentProxy> {
  ensureWorkerConfigured();
  return pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
}

/** How long an unreferenced document stays loaded before it is destroyed. */
const DOCUMENT_IDLE_MS = 5 * 60_000;

interface CachedDocument {
  task: PDFDocumentLoadingTask;
  promise: Promise<PDFDocumentProxy>;
  resolved: PDFDocumentProxy | null;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const documents = new Map<string, CachedDocument>();

function destroyDocument(src: string, entry: CachedDocument): void {
  if (documents.get(src) === entry) documents.delete(src);
  forgetRenderedPages(src);
  void entry.task.destroy();
}

/** Takes a reference on the shared document for `src`; call `release` when done. */
function acquireDocument(src: string): {
  entry: CachedDocument;
  release: () => void;
} {
  let entry = documents.get(src);
  if (entry === undefined) {
    ensureWorkerConfigured();
    const task = pdfjsLib.getDocument({ url: src });
    const created: CachedDocument = {
      task,
      promise: task.promise,
      resolved: null,
      refs: 0,
      idleTimer: null,
    };
    created.promise.then(
      (pdf) => {
        created.resolved = pdf;
      },
      () => {
        // Failed loads are dropped so a later mount can retry.
        if (documents.get(src) === created) documents.delete(src);
      },
    );
    documents.set(src, created);
    entry = created;
  }
  const held = entry;
  if (held.idleTimer !== null) {
    clearTimeout(held.idleTimer);
    held.idleTimer = null;
  }
  held.refs += 1;
  let released = false;
  return {
    entry: held,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      held.idleTimer = setTimeout(
        () => destroyDocument(src, held),
        DOCUMENT_IDLE_MS,
      );
    },
  };
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

function initialState(src: string | null | undefined): PdfDocumentState {
  if (!src) return EMPTY_STATE;
  const resolved = documents.get(src)?.resolved ?? null;
  return resolved !== null
    ? { document: resolved, loading: false, error: null }
    : LOADING_STATE;
}

/** Resolves the shared PDFDocumentProxy for a source URL; `null`/empty src resolves to an empty state. */
export function usePdfDocument(src?: string | null): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>(() => initialState(src));

  useEffect(() => {
    if (!src) {
      setState(EMPTY_STATE);
      return;
    }
    let cancelled = false;
    const { entry, release } = acquireDocument(src);
    if (entry.resolved !== null) {
      const pdf = entry.resolved;
      setState((current) =>
        current.document === pdf
          ? current
          : { document: pdf, loading: false, error: null },
      );
    } else {
      setState(LOADING_STATE);
      entry.promise.then(
        (pdf) => {
          if (!cancelled)
            setState({ document: pdf, loading: false, error: null });
        },
        (err: unknown) => {
          if (!cancelled)
            setState({
              document: null,
              loading: false,
              error: messageFromError(err),
            });
        },
      );
    }
    return () => {
      cancelled = true;
      release();
    };
  }, [src]);

  return state;
}
