// Offscreen read-only note rendering for AI screenshots and browser PDF export.
import { createRoot } from "react-dom/client";
import type {
  Background,
  CanvasMode,
  CanvasObject,
  RegionalObjectQueryResponse,
} from "@aurora/shared";
import { apiPost } from "../../lib/http.js";
import { sortByZIndex } from "../canvas/culling.js";
import { HtmlObject, SceneObject } from "../canvas/ObjectRenderer.js";
import {
  PAGE_GAP,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  pagedPageIndexAtY,
} from "../canvas/pageLayout.js";
import { boundsIntersect } from "../canvas/viewport.js";
import { fetchNote, type PageJson } from "../library/api.js";
import "../canvas/canvasStyles.css";

const MAX_WIDTH = 1600;
const TILE_HEIGHT = 1600;
const PDF_RENDER_TIMEOUT = 30_000;
const PRINT_CLEANUP_TIMEOUT = 60_000;
const PRINT_STYLES =
  "html,body{margin:0;background:#fff}.pdf-print-page{width:8.5in;height:11in;overflow:hidden;break-after:page;print-color-adjust:exact}.pdf-print-page:last-child{break-after:auto}.pdf-print-page .chat-note-snapshot{width:8.5in!important;height:11in!important}@page{size:8.5in 11in;margin:0}";

const NOOP = {
  onRichTextChange: () => undefined,
  onStickyTextChange: () => undefined,
};

export interface ExportPage {
  x: number;
  y: number;
  width: number;
  height: number;
  background: Background;
}

/** Returns fixed print regions for every supported canvas mode. */
export function planPdfPages(
  mode: CanvasMode,
  background: Background,
  objects: CanvasObject[],
  pages: PageJson[],
): ExportPage[] {
  const importedPages = objects
    .filter(
      (object) =>
        object.kind === "pdf-page-reference" &&
        object.payload.importedDocument === true,
    )
    .sort((a, b) => a.bounds.y - b.bounds.y);
  if (importedPages.length > 0) {
    return importedPages.map((object) => ({ ...object.bounds, background }));
  }

  if (mode === "paged") {
    const inferredCount = Math.max(
      1,
      ...objects.map(
        (object) =>
          pagedPageIndexAtY(object.bounds.y + object.bounds.height - 1) + 1,
      ),
    );
    const count = Math.max(pages.length, inferredCount);
    return Array.from({ length: count }, (_, index) => ({
      x: 0,
      y: index * (PAGE_HEIGHT + PAGE_GAP),
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      background: pages[index]?.background ?? background,
    }));
  }

  const minX = Math.min(0, ...objects.map((object) => object.bounds.x));
  const minY = Math.min(0, ...objects.map((object) => object.bounds.y));
  const maxX = Math.max(
    PAGE_WIDTH,
    ...objects.map((object) => object.bounds.x + object.bounds.width),
  );
  const maxY = Math.max(
    PAGE_HEIGHT,
    ...objects.map((object) => object.bounds.y + object.bounds.height),
  );
  if (mode === "fixed-width") {
    const startY = Math.floor(minY / PAGE_HEIGHT) * PAGE_HEIGHT;
    return Array.from(
      { length: Math.ceil((maxY - startY) / PAGE_HEIGHT) },
      (_, index) => ({
        x: 0,
        y: startY + index * PAGE_HEIGHT,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        background,
      }),
    );
  }
  if (mode === "fixed-height") {
    const startX = Math.floor(minX / PAGE_WIDTH) * PAGE_WIDTH;
    return Array.from(
      { length: Math.ceil((maxX - startX) / PAGE_WIDTH) },
      (_, index) => ({
        x: startX + index * PAGE_WIDTH,
        y: 0,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        background,
      }),
    );
  }

  const startX = Math.floor(minX / PAGE_WIDTH) * PAGE_WIDTH;
  const startY = Math.floor(minY / PAGE_HEIGHT) * PAGE_HEIGHT;
  const columns = Math.ceil((maxX - startX) / PAGE_WIDTH);
  const rows = Math.ceil((maxY - startY) / PAGE_HEIGHT);
  return Array.from({ length: columns * rows }, (_, index) => ({
    x: startX + (index % columns) * PAGE_WIDTH,
    y: startY + Math.floor(index / columns) * PAGE_HEIGHT,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    background,
  }));
}

/** Rejects bounded export work instead of leaving the print window stuck. */
async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs: number = PDF_RENDER_TIMEOUT,
): Promise<T> {
  let timer = 0;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    window.clearTimeout(timer);
  }
}

/** Loads all note objects in the server's bounded regional query. */
async function loadNoteObjects(
  noteId: string,
  signal?: AbortSignal,
): Promise<RegionalObjectQueryResponse> {
  return apiPost(
    `/api/notes/${noteId}/objects/query`,
    {
      viewport: {
        x: -1_000_000,
        y: -1_000_000,
        width: 2_000_000,
        height: 2_000_000,
      },
    },
    signal ? { signal } : {},
  );
}

/** Waits for imported PDF canvases inside an offscreen export scene. */
async function waitForPdfCanvases(
  host: HTMLElement,
  expected: number,
): Promise<void> {
  if (expected === 0) return;
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    const check = (): void => {
      if (
        host.querySelectorAll('canvas[data-pdf-rendered="true"]').length >=
        expected
      ) {
        resolve();
        return;
      }
      if (performance.now() - started >= PDF_RENDER_TIMEOUT) {
        reject(new Error("Rendering an imported PDF page timed out"));
        return;
      }
      window.setTimeout(check, 50);
    };
    check();
  });
}

/** Renders one bounded canvas region to a PNG. */
export async function renderNoteRegion(
  objects: CanvasObject[],
  region: ExportPage,
): Promise<string> {
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;pointer-events:none;z-index:-1;";
  document.body.appendChild(host);
  const root = createRoot(host);
  const visibleObjects = objects.filter((object) =>
    boundsIntersect(object.bounds, region),
  );
  try {
    root.render(
      <NoteSnapshotScene
        objects={visibleObjects}
        minX={region.x}
        minY={region.y}
        width={region.width}
        height={region.height}
        scale={Math.min(1, MAX_WIDTH / region.width)}
        background={region.background}
      />,
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await waitForPdfCanvases(
      host,
      visibleObjects.filter(
        (object) =>
          object.kind === "pdf-page-reference" &&
          object.payload.importedDocument === true,
      ).length,
    );
    const scene = host.querySelector(
      ".chat-note-snapshot",
    ) as HTMLElement | null;
    if (!scene) throw new Error("Note export failed to mount");
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await withTimeout(
      html2canvas(scene, {
        backgroundColor: null,
        imageTimeout: 5_000,
        logging: false,
        scale: 1,
        useCORS: true,
      }),
      "PDF page rendering timed out",
    );
    return canvas.toDataURL("image/png");
  } finally {
    root.unmount();
    host.remove();
  }
}

/** Rasterizes planned note regions in print order. */
export async function renderPdfPages(
  objects: CanvasObject[],
  regions: ExportPage[],
  onPageStart?: (page: number, total: number) => void,
): Promise<string[]> {
  const sources: string[] = [];
  for (const [index, region] of regions.entries()) {
    onPageStart?.(index + 1, regions.length);
    sources.push(await renderNoteRegion(objects, region));
  }
  return sources;
}

function PrintablePages({
  objects,
  regions,
}: {
  objects: CanvasObject[];
  regions: ExportPage[];
}) {
  return (
    <>
      {regions.map((region, index) => (
        <div className="pdf-print-page" key={index}>
          <NoteSnapshotScene
            objects={objects.filter((object) =>
              boundsIntersect(object.bounds, region),
            )}
            minX={region.x}
            minY={region.y}
            width={region.width}
            height={region.height}
            scale={1}
            background={region.background}
          />
        </div>
      ))}
    </>
  );
}

/**
 * Swaps rendered PDF canvases for images of their pixels. Chrome can print a never-displayed
 * canvas by replaying its drawing commands, which loses pdf.js's page fonts and prints every
 * glyph as a box. Returns the object URLs to revoke once printing is done.
 */
async function freezePdfCanvases(host: HTMLElement): Promise<string[]> {
  const canvases = [
    ...host.querySelectorAll<HTMLCanvasElement>(
      'canvas[data-pdf-rendered="true"]',
    ),
  ];
  return Promise.all(
    canvases.map(async (canvas) => {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (blob === null) throw new Error("Could not capture a PDF page");
      const url = URL.createObjectURL(blob);
      const image = canvas.ownerDocument.createElement("img");
      image.className = canvas.className;
      image.alt = "";
      image.src = url;
      // The canvas stays mounted (hidden) so React still owns the nodes it rendered.
      canvas.style.display = "none";
      canvas.after(image);
      return url;
    }),
  );
}

/** Mounts vector note pages directly into the print document without rasterizing them. */
export async function mountPrintablePages(
  targetDocument: Document,
  objects: CanvasObject[],
  regions: ExportPage[],
): Promise<() => void> {
  const root = createRoot(targetDocument.body);
  let imageUrls: string[] = [];
  const unmount = (): void => {
    root.unmount();
    for (const url of imageUrls) URL.revokeObjectURL(url);
  };
  try {
    root.render(<PrintablePages objects={objects} regions={regions} />);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await waitForPdfCanvases(
      targetDocument.body,
      objects.filter(
        (object) =>
          object.kind === "pdf-page-reference" &&
          object.payload.importedDocument === true,
      ).length,
    );
    imageUrls = await freezePdfCanvases(targetDocument.body);
    await withTimeout(
      Promise.allSettled(
        [...targetDocument.images].map((image) => image.decode()),
      ).then(() => undefined),
      "Loading images for PDF export timed out",
      5_000,
    );
  } catch (cause) {
    unmount();
    throw cause;
  }
  return unmount;
}

/** Copies the app's stylesheets into the print document and waits for linked sheets to load. */
async function copyStylesheets(targetDocument: Document): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const node of document.head.querySelectorAll(
    'link[rel="stylesheet"], style',
  )) {
    // The copy belongs to the iframe's realm, so test the original node's type.
    const copy = targetDocument.importNode(node, true);
    if (node instanceof HTMLLinkElement) {
      pending.push(
        new Promise<void>((resolve) => {
          copy.addEventListener("load", () => resolve(), { once: true });
          copy.addEventListener("error", () => resolve(), { once: true });
        }),
      );
    }
    targetDocument.head.appendChild(copy);
  }
  await withTimeout(
    Promise.all(pending).then(() => undefined),
    "Loading styles for PDF export timed out",
  );
}

/** Opens the browser print dialog for a note from a hidden iframe so it can be saved as PDF. */
export async function exportNoteToPdf(
  noteId: string,
  title: string,
): Promise<void> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;";
  document.body.appendChild(iframe);

  let unmount: (() => void) | null = null;
  let cleanupTimer = 0;
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    window.clearTimeout(cleanupTimer);
    unmount?.();
    iframe.remove();
  };

  try {
    const printWindow = iframe.contentWindow;
    const printDocument = iframe.contentDocument;
    if (!printWindow || !printDocument) {
      throw new Error("Could not prepare the note for printing");
    }
    printDocument.open();
    printDocument.write(
      '<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>',
    );
    printDocument.close();
    printDocument.title = title;

    const [, [{ note, pages }, response]] = await Promise.all([
      copyStylesheets(printDocument),
      withTimeout(
        Promise.all([fetchNote(noteId), loadNoteObjects(noteId)]),
        "Loading the note for PDF export timed out",
      ),
    ]);
    if (response.truncated) {
      throw new Error("This note is too large to export in one PDF");
    }
    const style = printDocument.createElement("style");
    style.textContent = PRINT_STYLES;
    printDocument.head.appendChild(style);

    const regions = planPdfPages(
      note.canvasMode,
      note.background,
      response.objects,
      pages,
    );
    unmount = await mountPrintablePages(
      printDocument,
      response.objects,
      regions,
    );
    printWindow.addEventListener("afterprint", cleanup, { once: true });
    cleanupTimer = window.setTimeout(cleanup, PRINT_CLEANUP_TIMEOUT);
    printWindow.focus();
    printWindow.print();
  } catch (cause) {
    cleanup();
    throw cause;
  }
}

/** Renders one tile used by the AI screenshot tool. */
export async function screenshotNote(
  noteId: string,
  tile = 0,
  signal?: AbortSignal,
): Promise<{ images: string[]; tileCount: number; truncated: boolean }> {
  const response = await loadNoteObjects(noteId, signal);
  const objects = response.objects;
  const minX = Math.min(0, ...objects.map((object) => object.bounds.x));
  const minY = Math.min(0, ...objects.map((object) => object.bounds.y));
  const maxX = Math.max(
    800,
    ...objects.map((object) => object.bounds.x + object.bounds.width),
  );
  const maxY = Math.max(
    600,
    ...objects.map((object) => object.bounds.y + object.bounds.height),
  );
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const scale = Math.min(1, MAX_WIDTH / width);
  const renderHeight = Math.ceil(height * scale);
  const tileCount = Math.max(1, Math.ceil(renderHeight / TILE_HEIGHT));
  if (!Number.isInteger(tile) || tile < 0 || tile >= tileCount) {
    throw new Error(`Screenshot tile ${tile} is outside 0-${tileCount - 1}`);
  }
  const y = (tile * TILE_HEIGHT) / scale;
  const clipHeight = Math.min(TILE_HEIGHT / scale, height - y);
  const background: Background = {
    pattern: "solid",
    color: "#1b1d21",
    patternColor: "#1b1d21",
    spacing: 24,
  };
  const png = await renderNoteRegion(objects, {
    x: minX,
    y: minY + y,
    width,
    height: clipHeight,
    background,
  });
  return {
    images: [png],
    tileCount,
    truncated: response.truncated || tile + 1 < tileCount,
  };
}

/** Paints the note background as SVG so browser rasterizers retain its pattern. */
function SnapshotBackground({
  background,
  minX,
  minY,
  width,
  height,
}: {
  background: Background;
  minX: number;
  minY: number;
  width: number;
  height: number;
}) {
  const patternId = "snapshot-background-pattern";
  const patterned =
    background.pattern === "ruled" ||
    background.pattern === "square-grid" ||
    background.pattern === "dot-grid";
  return (
    <>
      {patterned ? (
        <defs>
          <pattern
            id={patternId}
            width={background.spacing}
            height={background.spacing}
            patternUnits="userSpaceOnUse"
          >
            {background.pattern === "dot-grid" ? (
              <circle cx="1" cy="1" r="1" fill={background.patternColor} />
            ) : (
              <>
                <path
                  d={`M 0 0 H ${background.spacing}`}
                  stroke={background.patternColor}
                  strokeWidth="1"
                />
                {background.pattern === "square-grid" ? (
                  <path
                    d={`M 0 0 V ${background.spacing}`}
                    stroke={background.patternColor}
                    strokeWidth="1"
                  />
                ) : null}
              </>
            )}
          </pattern>
        </defs>
      ) : null}
      <rect
        x={minX}
        y={minY}
        width={width}
        height={height}
        fill={background.color}
      />
      {patterned ? (
        <rect
          x={minX}
          y={minY}
          width={width}
          height={height}
          fill={`url(#${patternId})`}
        />
      ) : null}
    </>
  );
}

/** Object kinds the live canvas paints as HTML beneath the SVG scene layer. */
const UNDERLAY_KINDS: ReadonlySet<CanvasObject["kind"]> = new Set([
  "image",
  "pdf-page-reference",
]);
/** Object kinds the live canvas paints in its SVG scene layer. */
const SCENE_KINDS: ReadonlySet<CanvasObject["kind"]> = new Set([
  "stroke",
  "rectangle",
  "ellipse",
  "line",
  "arrow",
  "matrix",
]);

/**
 * Splits objects into the live canvas's paint bands: images and PDF pages,
 * then vector scene objects, then the remaining HTML objects, each in z-order.
 */
export function snapshotLayers(objects: CanvasObject[]): {
  underlay: CanvasObject[];
  scene: CanvasObject[];
  overlay: CanvasObject[];
} {
  const sorted = sortByZIndex(objects);
  return {
    underlay: sorted.filter((object) => UNDERLAY_KINDS.has(object.kind)),
    scene: sorted.filter((object) => SCENE_KINDS.has(object.kind)),
    overlay: sorted.filter(
      (object) =>
        !UNDERLAY_KINDS.has(object.kind) && !SCENE_KINDS.has(object.kind),
    ),
  };
}

function NoteSnapshotScene({
  objects,
  minX,
  minY,
  width,
  height,
  scale,
  background,
}: {
  objects: CanvasObject[];
  minX: number;
  minY: number;
  width: number;
  height: number;
  scale: number;
  background: Background;
}) {
  const { underlay, scene, overlay } = snapshotLayers(objects);
  const viewBox = `${minX} ${minY} ${width} ${height}`;
  const htmlLayer = (layer: CanvasObject[]) => (
    <div
      style={{
        position: "absolute",
        left: -minX,
        top: -minY,
        width,
        height,
      }}
    >
      {layer.map((object) => (
        <HtmlObject
          key={object.id}
          object={object}
          interactive={false}
          selected={false}
          callbacks={NOOP}
        />
      ))}
    </div>
  );
  return (
    <div
      className="chat-note-snapshot"
      style={{
        width: Math.ceil(width * scale),
        height: Math.ceil(height * scale),
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width,
          height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "relative",
          backgroundColor: background.color,
        }}
      >
        <svg
          width={width}
          height={height}
          viewBox={viewBox}
          style={{ position: "absolute", inset: 0 }}
        >
          <SnapshotBackground
            background={background}
            minX={minX}
            minY={minY}
            width={width}
            height={height}
          />
        </svg>
        {underlay.length > 0 ? htmlLayer(underlay) : null}
        {scene.length > 0 ? (
          <svg
            width={width}
            height={height}
            viewBox={viewBox}
            style={{ position: "absolute", inset: 0 }}
          >
            {scene.map((object) => (
              <SceneObject key={object.id} object={object} />
            ))}
          </svg>
        ) : null}
        {overlay.length > 0 ? htmlLayer(overlay) : null}
      </div>
    </div>
  );
}
