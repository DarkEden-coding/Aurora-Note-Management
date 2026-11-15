// Offscreen read-only note rendering for AI screenshots and PDF download export.
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
import { getPdfPageReference } from "../canvas/objects.js";
import {
  PAGE_GAP,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  pagedPageIndexAtY,
} from "../canvas/pageLayout.js";
import { boundsIntersect } from "../canvas/viewport.js";
import { fetchNote, type PageJson } from "../library/api.js";
import type { PDFDocument } from "pdf-lib";
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
  /** Original PDF page shown in this region, embedded as vector content on export. */
  importedPdf?: { url: string; pageNumber: number };
}

/** PDF points per CSS pixel (72 / 96). */
const POINTS_PER_PIXEL = 0.75;
/** Device pixels per CSS pixel for rasterized export content. */
const EXPORT_PIXEL_RATIO = 2;

function isImportedPdfPage(object: CanvasObject): boolean {
  return (
    object.kind === "pdf-page-reference" &&
    object.payload.importedDocument === true
  );
}

/** Returns fixed print regions for every supported canvas mode. */
export function planPdfPages(
  mode: CanvasMode,
  background: Background,
  objects: CanvasObject[],
  pages: PageJson[],
): ExportPage[] {
  const importedPages = objects
    .filter(isImportedPdfPage)
    .sort((a, b) => a.bounds.y - b.bounds.y);
  if (importedPages.length > 0) {
    return importedPages.map((object) => {
      const ref = getPdfPageReference(object);
      return {
        ...object.bounds,
        background,
        ...(ref?.pdfUrl
          ? { importedPdf: { url: ref.pdfUrl, pageNumber: ref.pageNumber } }
          : {}),
      };
    });
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

/** Draws the scene's SVG layers straight onto a canvas; valid when the scene has no HTML objects. */
async function rasterizeSvgLayers(
  scene: HTMLElement,
  pixelRatio: number,
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(scene.offsetWidth * pixelRatio);
  canvas.height = Math.ceil(scene.offsetHeight * pixelRatio);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create an export canvas");
  for (const svg of scene.querySelectorAll("svg")) {
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    copy.setAttribute("width", String(canvas.width));
    copy.setAttribute("height", String(canvas.height));
    copy.removeAttribute("style");
    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(copy)], {
        type: "image/svg+xml",
      }),
    );
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      context.drawImage(image, 0, 0);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return canvas.toDataURL("image/png");
}

/** Renders one bounded canvas region to a PNG; `transparent` omits the note background. */
export async function renderNoteRegion(
  objects: CanvasObject[],
  region: ExportPage,
  { pixelRatio = 1, transparent = false } = {},
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
        background={transparent ? null : region.background}
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
      visibleObjects.filter(isImportedPdfPage).length,
    );
    await withTimeout(
      Promise.allSettled(
        [...host.querySelectorAll("img")].map((image) => image.decode()),
      ),
      "Loading images for the note snapshot timed out",
    );
    const scene = host.querySelector(
      ".chat-note-snapshot",
    ) as HTMLElement | null;
    if (!scene) throw new Error("Note export failed to mount");
    if (visibleObjects.every((object) => SCENE_KINDS.has(object.kind))) {
      return await rasterizeSvgLayers(scene, pixelRatio);
    }
    const { default: html2canvas } = await import("html2canvas");
    const canvas = await withTimeout(
      html2canvas(scene, {
        backgroundColor: null,
        imageTimeout: 5_000,
        logging: false,
        scale: pixelRatio,
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

/** Loads a source PDF once per export. */
function sourcePdfLoader(): (url: string) => Promise<PDFDocument> {
  const cache = new Map<string, Promise<PDFDocument>>();
  return (url) => {
    let source = cache.get(url);
    if (!source) {
      source = (async () => {
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) throw new Error("Could not load the imported PDF");
        const { PDFDocument } = await import("pdf-lib");
        return PDFDocument.load(await response.arrayBuffer(), {
          ignoreEncryption: true,
        });
      })();
      cache.set(url, source);
    }
    return source;
  };
}

/** Saves a blob through a temporary download link. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function pdfFilename(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim();
  return `${base || "Untitled"}.pdf`;
}

/** Builds a PDF of the note and downloads it. Imported PDF pages stay vector; notes on top are rasterized. */
export async function exportNoteToPdf(
  noteId: string,
  title: string,
): Promise<void> {
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
  const drawable = response.objects.filter(
    (object) => !isImportedPdfPage(object),
  );
  const { PDFDocument } = await import("pdf-lib");
  const output = await PDFDocument.create();
  output.setTitle(title);
  const loadSource = sourcePdfLoader();

  for (const region of regions) {
    const content = drawable.filter((object) =>
      boundsIntersect(object.bounds, region),
    );
    let page;
    if (region.importedPdf) {
      const source = await loadSource(region.importedPdf.url);
      const [original] = await output.embedPdf(source, [
        region.importedPdf.pageNumber - 1,
      ]);
      page = output.addPage([original!.width, original!.height]);
      page.drawPage(original!);
      if (content.length === 0) continue;
    } else {
      page = output.addPage([
        region.width * POINTS_PER_PIXEL,
        region.height * POINTS_PER_PIXEL,
      ]);
    }
    const png = await renderNoteRegion(content, region, {
      pixelRatio: EXPORT_PIXEL_RATIO,
      transparent: region.importedPdf !== undefined,
    });
    page.drawImage(await output.embedPng(png), {
      x: 0,
      y: 0,
      width: page.getWidth(),
      height: page.getHeight(),
    });
  }

  const bytes = await output.save();
  downloadBlob(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
    pdfFilename(title),
  );
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

/** Read-only scene layered like the workspace: images and PDF pages, then ink and shapes, then text. */
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
  background: Background | null;
}) {
  const { underlay, scene, overlay } = snapshotLayers(objects);
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
          ...(background ? { backgroundColor: background.color } : {}),
        }}
      >
        {background ? (
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
          </svg>
        ) : null}
        {htmlLayer(underlay)}
        <svg
          width={width}
          height={height}
          viewBox={`${minX} ${minY} ${width} ${height}`}
          style={{ position: "absolute", inset: 0 }}
        >
          {scene.map((object) => (
            <SceneObject key={object.id} object={object} />
          ))}
        </svg>
        {htmlLayer(overlay)}
      </div>
    </div>
  );
}
