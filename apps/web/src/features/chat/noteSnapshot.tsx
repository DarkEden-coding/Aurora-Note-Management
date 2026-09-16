// Offscreen read-only note rendering for AI screenshots and browser PDF export.
import { createRoot } from "react-dom/client";
import type {
  Background,
  CanvasMode,
  CanvasObject,
  RegionalObjectQueryResponse,
} from "@aurora/shared";
import { apiPost } from "../../lib/http.js";
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
  onPrint,
}: {
  objects: CanvasObject[];
  regions: ExportPage[];
  onPrint: () => void;
}) {
  return (
    <>
      <div className="pdf-print-controls">
        <span>{regions.length} pages ready</span>
        <button type="button" onClick={onPrint}>
          Print or save PDF
        </button>
      </div>
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

/** Mounts vector note pages directly into the print window without rasterizing them. */
export async function mountPrintablePages(
  targetDocument: Document,
  objects: CanvasObject[],
  regions: ExportPage[],
): Promise<() => void> {
  const root = createRoot(targetDocument.body);
  root.render(
    <PrintablePages
      objects={objects}
      regions={regions}
      onPrint={() => targetDocument.defaultView?.print()}
    />,
  );
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await waitForPdfCanvases(
    targetDocument.body,
    objects.filter(
      (object) =>
        object.kind === "pdf-page-reference" &&
        object.payload.importedDocument === true,
    ).length,
  );
  await withTimeout(
    Promise.allSettled(
      [...targetDocument.images].map((image) => image.decode()),
    ).then(() => undefined),
    "Loading images for PDF export timed out",
    5_000,
  );
  return () => root.unmount();
}

/** Opens a print-ready copy of a note so the browser can save it as PDF. */
export async function exportNoteToPdf(
  noteId: string,
  title: string,
): Promise<void> {
  const printWindow = window.open("", "_blank");
  if (!printWindow) throw new Error("Allow pop-ups to export this note");

  printWindow.document.title = title;
  for (const stylesheet of document.querySelectorAll(
    'link[rel="stylesheet"]',
  )) {
    printWindow.document.head.appendChild(stylesheet.cloneNode(true));
  }
  const style = printWindow.document.createElement("style");
  style.textContent =
    "html,body{margin:0;background:#fff}.pdf-print-controls{position:fixed;z-index:100;top:12px;right:12px;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;color:#fff;background:#20242c;box-shadow:0 4px 16px #0008}.pdf-print-controls button{padding:8px 12px;border:0;border-radius:6px;cursor:pointer}.pdf-print-page{width:8.5in;height:11in;overflow:hidden;break-after:page;print-color-adjust:exact}.pdf-print-page:last-child{break-after:auto}.pdf-print-page .chat-note-snapshot{width:8.5in!important;height:11in!important}@media print{.pdf-print-controls{display:none}}@page{size:8.5in 11in;margin:0}";
  printWindow.document.head.appendChild(style);
  printWindow.document.body.textContent = "Preparing PDF…";

  try {
    const [{ note, pages }, response] = await withTimeout(
      Promise.all([fetchNote(noteId), loadNoteObjects(noteId)]),
      "Loading the note for PDF export timed out",
    );
    if (response.truncated) {
      throw new Error("This note is too large to export in one PDF");
    }
    const regions = planPdfPages(
      note.canvasMode,
      note.background,
      response.objects,
      pages,
    );
    await mountPrintablePages(printWindow.document, response.objects, regions);
    printWindow.focus();
    printWindow.print();
  } catch (cause) {
    printWindow.close();
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
  const html = objects.filter((object) =>
    [
      "rich-text",
      "sticky-note",
      "image",
      "attachment",
      "pdf-page-reference",
    ].includes(object.kind),
  );
  const scene = objects.filter((object) => !html.includes(object));
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
          viewBox={`${minX} ${minY} ${width} ${height}`}
          style={{ position: "absolute", inset: 0 }}
        >
          <SnapshotBackground
            background={background}
            minX={minX}
            minY={minY}
            width={width}
            height={height}
          />
          {scene.map((object) => (
            <SceneObject key={object.id} object={object} />
          ))}
        </svg>
        <div
          style={{
            position: "absolute",
            left: -minX,
            top: -minY,
            width,
            height,
          }}
        >
          {html.map((object) => (
            <HtmlObject
              key={object.id}
              object={object}
              interactive={false}
              selected={false}
              callbacks={NOOP}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
