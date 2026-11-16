// Canvas workspace composition: four canvas modes, viewport transform with overscan culling, backgrounds, selection/move/resize gestures, pen capture with palm rejection, mouse/touch navigation, paged page frames, and object creation. Edits emit coalesced SyncOperations through onOperation; object rendering is delegated to ObjectRenderer, and the sync cache supplies objects when the prop is omitted.
import type React from "react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  idSchema,
  type Bounds,
  type Background,
  type CanvasMode,
  type CanvasObject,
  type DrawingPalette,
  type SyncOperation,
  type Viewport,
} from "@aurora/shared";
import { reconcileObject } from "./reconcileObject";
import { db } from "../../sync/db";
import {
  createPageBelow as createPersistedPageBelow,
  fetchNote,
} from "../library/api";
import { syncEngine } from "../../sync/engine";
import { Plus } from "lucide-react";
import { CanvasScrollbars } from "./CanvasScrollbars";
import { CanvasToolbar, type CanvasTool } from "./CanvasToolbar";
import {
  DrawingPlacementPanel,
  DrawingStyleControls,
  ShapePropertiesButton,
  type DrawingStyle,
  type VectorTool,
} from "./DrawingProperties";
import {
  HtmlObject,
  MemoizedSceneObject as SceneObject,
  type HtmlObjectCallbacks,
} from "./ObjectRenderer";
import { DEFAULT_BACKGROUND, getBackgroundStyle } from "./backgrounds";
import { DEFAULT_OVERSCAN, queryVisibleObjects, sortByZIndex } from "./culling";
import { buildDemoObjects } from "./DemoContent";
import {
  dragBoundsFree,
  fitImageSize,
  getShapeColor,
  getShapeCornerRadius,
  getShapeFill,
  getShapeFillOpacity,
  getShapeLineStyle,
  getShapeStrokeWidth,
  handleAtPoint,
  handlePositions,
  hitTestLineObject,
  hitTestTopmost,
  hitTestTopmostStroke,
  lineGeometryFromDrag,
  makeCanvasObject,
  makeImagePayload,
  moveObjectToBounds,
  nextZIndex,
  pointsToBounds,
  resizeObjectToBounds,
  setLineEndpointPayload,
  setStrokePayload,
  translateStrokePoints,
  type Handle,
} from "./objects";
import {
  getDeviceId,
  makeDeleteOperation,
  makeUpsertOperation,
  newId,
} from "./operations";
import {
  DEMO_OWNER_ID,
  PAGE_GAP,
  PAGE_HEIGHT,
  canvasScrollBounds,
  canvasSurfaceFrames,
  clampBoundsToMode,
  translateBoundsInMode,
  resizeBoundsInMode,
} from "./pageLayout";
import { shouldRejectTouch } from "./pointerInput";
import { SelectionActions } from "./SelectionActions";
import {
  boxPolygon,
  cloneObjects,
  objectsInRegion,
  unionBounds,
} from "./selectionRegion";
import { usePenCapture } from "./usePenCapture";
import { useSelection } from "./useSelection";
import { useViewport } from "./useViewport";
import {
  boundsContainPoint,
  boundsIntersect,
  screenToCanvas,
  type Point,
} from "./viewport";

export interface CanvasWorkspaceProps {
  /** Authenticated owner for newly created persisted objects; omit only in demos. */
  ownerId?: string;
  noteId: string;
  /** Canvas mode; defaults to "infinite". */
  mode?: CanvasMode;
  background?: Background;
  /** Canonical objects; when omitted, the workspace loads from the local sync cache and falls back to demo content. */
  objects?: CanvasObject[];
  /** Account-synced colors available to drawing controls. */
  drawingPalette?: DrawingPalette;
  onDrawingPaletteChange?: (palette: DrawingPalette) => void | Promise<void>;
  /** Receives every coalesced upsert/delete operation produced by editing gestures. */
  onOperation?: (operation: SyncOperation) => void;
  /** PDF selected while creating this note from the library. */
  importedPdf?: File;
  onPdfImported?: () => void;
}

const STROKE_TOOL_WIDTH = 2.5;
const HIGHLIGHTER_STYLE_KEY = "aurora.highlighter";
const HIGHLIGHTER_PALETTE: DrawingPalette = [
  "#facc15",
  "#4ade80",
  "#38bdf8",
  "#f472b6",
  "#fb923c",
  "#a78bfa",
];
const DEFAULT_HIGHLIGHTER_STYLE: HighlighterStyle = {
  color: "#facc15",
  width: 14,
  palette: HIGHLIGHTER_PALETTE,
};

interface HighlighterStyle {
  color: string;
  width: number;
  palette: DrawingPalette;
}

/** Restores the last highlighter color, width, and palette from this browser. */
function loadHighlighterStyle(): HighlighterStyle {
  try {
    const raw = window.localStorage.getItem(HIGHLIGHTER_STYLE_KEY);
    if (raw === null) return DEFAULT_HIGHLIGHTER_STYLE;
    const parsed = JSON.parse(raw) as Partial<HighlighterStyle>;
    return {
      color:
        typeof parsed.color === "string"
          ? parsed.color
          : DEFAULT_HIGHLIGHTER_STYLE.color,
      width:
        typeof parsed.width === "number" && parsed.width > 0
          ? parsed.width
          : DEFAULT_HIGHLIGHTER_STYLE.width,
      palette:
        Array.isArray(parsed.palette) &&
        parsed.palette.length > 0 &&
        parsed.palette.every((color) => typeof color === "string")
          ? parsed.palette
          : HIGHLIGHTER_PALETTE,
    };
  } catch {
    return DEFAULT_HIGHLIGHTER_STYLE;
  }
}

/** Freehand ink tools share pen capture, palm rejection, and stroke storage. */
function isInkTool(tool: CanvasTool): tool is "pen" | "highlighter" {
  return tool === "pen" || tool === "highlighter";
}
const VIEWPORT_STATE_PREFIX = "aurora.viewport.";
const HANDLE_SCREEN_SIZE = 9;
const HANDLE_HIT_TOLERANCE_SCREEN = 12;

/** One active pointer gesture at a time. */
type Gesture =
  | { kind: "pan"; lastScreen: Point }
  | {
      kind: "erase";
      last: Point;
      removed: Map<string, CanvasObject>;
    }
  | { kind: "move"; ids: string[]; start: Point; origins: Map<string, Bounds> }
  | {
      kind: "resize";
      id: string;
      handle: Handle;
      start: Point;
      startBounds: Bounds;
      startObject: CanvasObject;
    }
  | {
      kind: "create";
      tool: CreateTool;
      start: Point;
      current: Point;
      snapTo45: boolean;
    }
  | {
      kind: "marquee";
      shape: "box" | "lasso";
      /** Canvas points: the two box corners, or the lasso path. */
      points: Point[];
      /** Selection kept when the region is added with Shift. */
      base: string[];
    };

type CreateTool =
  "line" | "rectangle" | "ellipse" | "arrow" | "matrix" | "text";

type HistoryEntry = {
  before: CanvasObject[];
  after: CanvasObject[];
};

type HistoryState = {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
};

const EMPTY_HISTORY: HistoryState = { undo: [], redo: [] };
const HISTORY_LIMIT = 50;
const ERASER_HIT_TOLERANCE_SCREEN = 10;
/** Canvas distance between a pasted or duplicated copy and its source. */
const PASTE_OFFSET = 24;
/** Screen distance a selection drag must travel before it selects a region. */
const MARQUEE_MIN_SCREEN = 4;
/** Screen gap between the selection and its action bar. */
const SELECTION_ACTIONS_GAP = 14;
/** Room the action bar needs above a selection before it flips below. */
const SELECTION_ACTIONS_MIN_TOP = 120;

/** Copied canvas objects, shared by every note in this tab. */
let canvasClipboard: {
  objects: CanvasObject[];
  sourceNoteId: string;
  pastes: number;
} | null = null;

/** Reads an image file's intrinsic dimensions without retaining its object URL. */
async function readImageSize(
  file: File,
): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Uploads one file and returns its durable server file ID. */
async function uploadFile(file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  const response = await fetch("/api/files", { method: "POST", body });
  if (!response.ok) throw new Error(`Upload failed (${response.status})`);
  const result = (await response.json()) as { file?: { id?: unknown } };
  if (typeof result.file?.id !== "string")
    throw new Error("Upload returned no file ID");
  return result.file.id;
}

const CREATE_TOOLS: readonly string[] = [
  "line",
  "rectangle",
  "ellipse",
  "arrow",
  "matrix",
  "text",
];

/** Restores a note's canvas position when the stored state is valid. */
function readSavedViewport(
  noteId: string,
): Pick<Viewport, "x" | "y" | "zoom"> | null {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(`${VIEWPORT_STATE_PREFIX}${noteId}`) ?? "null",
    );
    const candidate = saved as Record<string, unknown> | null;
    if (
      candidate !== null &&
      Number.isFinite(candidate.x) &&
      Number.isFinite(candidate.y) &&
      Number.isFinite(candidate.zoom) &&
      typeof candidate.x === "number" &&
      typeof candidate.y === "number" &&
      typeof candidate.zoom === "number" &&
      candidate.zoom > 0
    ) {
      return { x: candidate.x, y: candidate.y, zoom: candidate.zoom };
    }
  } catch {
    // Start at the default position when browser storage is unavailable or stale.
  }
  return null;
}

/** Saves only the canvas position needed to restore this note. */
function saveViewport(
  noteId: string,
  viewport: Pick<Viewport, "x" | "y" | "zoom">,
): void {
  try {
    localStorage.setItem(
      `${VIEWPORT_STATE_PREFIX}${noteId}`,
      JSON.stringify(viewport),
    );
  } catch {
    // State restoration is optional when browser storage is unavailable.
  }
}

function isCreateTool(tool: CanvasTool): tool is CreateTool {
  return CREATE_TOOLS.includes(tool);
}

function isVectorTool(tool: CanvasTool): tool is VectorTool {
  return (
    tool === "rectangle" ||
    tool === "ellipse" ||
    tool === "line" ||
    tool === "arrow" ||
    tool === "matrix"
  );
}

function isVectorObject(
  object: CanvasObject | null,
): object is CanvasObject & { kind: VectorTool } {
  return object !== null && isVectorTool(object.kind as CanvasTool);
}

/** Reads editable vector properties from a persisted object. */
function drawingStyleFromObject(object: CanvasObject): DrawingStyle {
  return {
    strokeColor: getShapeColor(object),
    fillColor: getShapeFill(object),
    fillOpacity: getShapeFillOpacity(object),
    strokeWidth: getShapeStrokeWidth(object),
    lineStyle: getShapeLineStyle(object),
    cornerRadius: getShapeCornerRadius(object),
  };
}

/** True when the pointer target belongs to editable chrome that must keep its events. */
function isInsideEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest('[data-rich-text-editable="true"]') !== null ||
    target.closest(".rich-text-toolbar") !== null ||
    target.closest('[data-editing="true"]') !== null
  );
}

export function CanvasWorkspace({
  ownerId,
  noteId,
  mode,
  background,
  objects,
  drawingPalette,
  onDrawingPaletteChange,
  onOperation,
  importedPdf,
  onPdfImported,
}: CanvasWorkspaceProps): ReactNode {
  const activeMode: CanvasMode = mode ?? "infinite";
  const isControlled = objects !== undefined;
  const [axisLocks, setAxisLocks] = useState({ x: false, y: false });
  const [eraserPointer, setEraserPointer] = useState<Point | null>(null);
  const canLockX = activeMode === "fixed-width" || activeMode === "paged";
  const canLockY = activeMode === "fixed-height";

  const {
    viewport,
    setViewport,
    containerRef,
    containerSize,
    panBy,
    startMomentum,
    stopMomentum,
    zoomAt,
    toCanvas,
  } = useViewport(
    {
      x: -64,
      y: -96,
      width: 0,
      height: 0,
      zoom: 1,
    },
    {
      x: canLockX && axisLocks.x,
      y: canLockY && axisLocks.y,
    },
  );

  const [mirror, setMirror] = useState<CanvasObject[]>(() => objects ?? []);
  const [pageCount, setPageCount] = useState(1);
  const [importError, setImportError] = useState<string | null>(null);
  const importedPdfRef = useRef<File | null>(null);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [placementPropertiesOpen, setPlacementPropertiesOpen] = useState(false);
  const changeTool = useCallback((nextTool: CanvasTool): void => {
    setTool(nextTool);
    setPlacementPropertiesOpen(
      isInkTool(nextTool) || nextTool === "text" || isVectorTool(nextTool),
    );
  }, []);
  const palette = drawingPalette ?? (["#000000"] as DrawingPalette);
  const [drawingStyle, setDrawingStyle] = useState<DrawingStyle>(() => ({
    strokeColor: palette[0] ?? "#000000",
    fillColor: null,
    fillOpacity: 100,
    strokeWidth: 2,
    lineStyle: "solid",
    cornerRadius: 2,
  }));
  const [highlighterStyle, setHighlighterStyle] =
    useState<HighlighterStyle>(loadHighlighterStyle);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        HIGHLIGHTER_STYLE_KEY,
        JSON.stringify(highlighterStyle),
      );
    } catch {
      // Highlighter defaults are optional when browser storage is unavailable.
    }
  }, [highlighterStyle]);
  const [shapePropertiesOpen, setShapePropertiesOpen] = useState(false);
  const shapeEditOriginRef = useRef<CanvasObject | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [history, setHistory] = useState<HistoryState>(EMPTY_HISTORY);
  const historyRef = useRef(history);
  historyRef.current = history;
  const selection = useSelection();
  const deviceIdRef = useRef(getDeviceId());
  const pinchRef = useRef<Map<number, Point>>(new Map());
  const pinchSpanRef = useRef<{
    distance: number;
    mid: Point;
    zoom: number;
  } | null>(null);
  const touchPanRef = useRef<{
    point: Point;
    time: number;
    velocity: Point;
  } | null>(null);
  const lastStylusTimeRef = useRef(Number.NEGATIVE_INFINITY);

  // Controlled mode: the parent's array is the source of truth.
  useEffect(() => {
    if (isControlled) setMirror(objects);
  }, [isControlled, objects]);

  useEffect(() => {
    setAxisLocks({ x: false, y: false });
  }, [activeMode, noteId]);

  useEffect(() => {
    if (activeMode !== "paged" || !idSchema.safeParse(noteId).success) {
      setPageCount(1);
      return;
    }
    let cancelled = false;
    const loadPages = (): void => {
      void fetchNote(noteId)
        .then(({ pages }) => {
          if (!cancelled) setPageCount(Math.max(1, pages.length));
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setImportError(
              error instanceof Error ? error.message : "Could not load pages",
            );
        });
    };
    loadPages();
    const unsubscribe = syncEngine.onLibraryChange(loadPages);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [activeMode, noteId]);

  const demoObjects = useMemo(
    () => (idSchema.safeParse(noteId).success ? [] : buildDemoObjects(noteId)),
    [noteId],
  );

  const pendingObjectsRef = useRef(new Map<string, CanvasObject>());

  // Reset the working set when the note changes.
  useEffect(() => {
    pendingObjectsRef.current.clear();
    setMirror(isControlled ? (objects ?? []) : []);
    selection.clear();
    setGesture(null);
    historyRef.current = EMPTY_HISTORY;
    setHistory(EMPTY_HISTORY);
    // Runs on note changes only; objects/selection intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  // Uncontrolled mode: seed from the local sync cache, falling back to demo content.
  useEffect(() => {
    if (isControlled) return;
    let cancelled = false;
    void db.objects
      .where("noteId")
      .equals(noteId)
      .toArray()
      .catch(() => [] as CanvasObject[])
      .then((rows) => {
        if (cancelled) return;
        setMirror((prev) =>
          prev.length > 0 ? prev : rows.length > 0 ? rows : demoObjects,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [isControlled, noteId, demoObjects]);

  // Uncontrolled mode: merge server broadcasts into the working set so remote
  // edits appear live. Newer revisions win; objects under an active gesture keep
  // their local state until the gesture commits.
  useEffect(() => {
    if (isControlled) return;
    return syncEngine.onRemoteChange((event) => {
      if (event.noteId !== noteId) return;
      setMirror((prev) => {
        let changed = false;
        const byId = new Map(prev.map((object) => [object.id, object]));
        const activeGesture = gestureRef.current;
        const gestureTouches = (objectId: string): boolean =>
          activeGesture !== null &&
          ((activeGesture.kind === "move" &&
            activeGesture.ids.includes(objectId)) ||
            (activeGesture.kind === "resize" &&
              activeGesture.id === objectId) ||
            (activeGesture.kind === "erase" &&
              activeGesture.removed.has(objectId)));

        for (const objectId of event.deletedObjectIds) {
          if (
            byId.has(objectId) &&
            !gestureTouches(objectId) &&
            !pendingObjectsRef.current.has(objectId)
          ) {
            byId.delete(objectId);
            changed = true;
          }
        }
        for (const remote of event.objects) {
          const local = byId.get(remote.id);
          if (local === undefined) {
            byId.set(remote.id, remote);
            changed = true;
          } else if (
            remote.revision > local.revision &&
            !gestureTouches(remote.id)
          ) {
            const result = reconcileObject(
              local,
              remote,
              pendingObjectsRef.current.get(remote.id),
            );
            byId.set(remote.id, result.object);
            if (result.acknowledged)
              pendingObjectsRef.current.delete(remote.id);
            changed = true;
          }
        }
        return changed ? [...byId.values()] : prev;
      });
    });
  }, [isControlled, noteId]);

  // Hydrate the current viewport after pan or zoom settles. The server applies
  // overscan and indexed bounds, so navigating an infinite note never fetches
  // every object.
  useEffect(() => {
    if (isControlled || containerSize.width === 0 || containerSize.height === 0)
      return;
    const timer = window.setTimeout(() => {
      void syncEngine.hydrate(noteId, {
        x: viewport.x,
        y: viewport.y,
        width: containerSize.width / viewport.zoom,
        height: containerSize.height / viewport.zoom,
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [
    isControlled,
    noteId,
    viewport.x,
    viewport.y,
    viewport.zoom,
    containerSize.width,
    containerSize.height,
  ]);

  const displayObjects = mirror;
  const objectsRef = useRef(displayObjects);
  objectsRef.current = displayObjects;
  const gestureRef = useRef<Gesture | null>(gesture);
  gestureRef.current = gesture;
  const setActiveGesture = useCallback((next: Gesture | null): void => {
    gestureRef.current = next;
    setGesture(next);
  }, []);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const onOperationRef = useRef(onOperation);
  onOperationRef.current = onOperation;

  const primaryId = useMemo(() => {
    let last: string | null = null;
    for (const id of selection.selectedIds) last = id;
    return last;
  }, [selection.selectedIds]);
  const primaryObject = useMemo(
    () => displayObjects.find((o) => o.id === primaryId) ?? null,
    [displayObjects, primaryId],
  );

  const commitUpsert = useCallback(
    (object: CanvasObject): void => {
      pendingObjectsRef.current.set(object.id, object);
      onOperationRef.current?.(
        makeUpsertOperation(object, noteId, deviceIdRef.current),
      );
    },
    [noteId],
  );

  const recordHistory = useCallback((entry: HistoryEntry): void => {
    const next = {
      undo: [...historyRef.current.undo, entry].slice(-HISTORY_LIMIT),
      redo: [],
    };
    historyRef.current = next;
    setHistory(next);
  }, []);

  const applyHistory = useCallback(
    (entry: HistoryEntry, side: "before" | "after"): void => {
      const desired = new Map(entry[side].map((object) => [object.id, object]));
      const changedIds = new Set([
        ...entry.before.map((object) => object.id),
        ...entry.after.map((object) => object.id),
      ]);
      const current = new Map(
        objectsRef.current.map((object) => [object.id, object]),
      );
      const next = objectsRef.current.filter(
        (object) => !changedIds.has(object.id),
      );
      const now = new Date().toISOString();

      for (const id of changedIds) {
        const existing = current.get(id);
        const target = desired.get(id);
        if (target === undefined) {
          if (existing !== undefined) {
            onOperationRef.current?.(
              makeDeleteOperation(
                id,
                existing.revision,
                noteId,
                deviceIdRef.current,
              ),
            );
          }
          continue;
        }
        const restored = {
          ...target,
          revision: existing?.revision ?? 0,
          updatedAt: now,
        };
        next.push(restored);
        commitUpsert(restored);
      }
      objectsRef.current = next;
      setMirror(next);
      selection.clear();
    },
    [commitUpsert, noteId, selection],
  );

  const undo = useCallback((): void => {
    const entry = historyRef.current.undo.at(-1);
    if (entry === undefined) return;
    applyHistory(entry, "before");
    const next = {
      undo: historyRef.current.undo.slice(0, -1),
      redo: [...historyRef.current.redo, entry],
    };
    historyRef.current = next;
    setHistory(next);
  }, [applyHistory]);

  const redo = useCallback((): void => {
    const entry = historyRef.current.redo.at(-1);
    if (entry === undefined) return;
    applyHistory(entry, "after");
    const next = {
      undo: [...historyRef.current.undo, entry],
      redo: historyRef.current.redo.slice(0, -1),
    };
    historyRef.current = next;
    setHistory(next);
  }, [applyHistory]);

  const appendObject = useCallback(
    (object: CanvasObject): void => {
      const next = [...objectsRef.current, object];
      objectsRef.current = next;
      setMirror(next);
      commitUpsert(object);
      recordHistory({ before: [], after: [object] });
    },
    [commitUpsert, recordHistory],
  );

  const importImages = useCallback(
    async (files: File[], at: Point): Promise<void> => {
      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length === 0) return;
      setImportError(null);
      try {
        for (const [index, file] of images.entries()) {
          const dimensions = await readImageSize(file);
          const fileId = await uploadFile(file);
          const size = fitImageSize(dimensions.width, dimensions.height);
          appendObject(
            makeCanvasObject({
              id: newId(),
              ownerId:
                ownerId ?? objectsRef.current[0]?.ownerId ?? DEMO_OWNER_ID,
              noteId,
              kind: "image",
              bounds: clampBoundsToMode(
                { ...size, x: at.x + index * 24, y: at.y + index * 24 },
                activeMode,
              ),
              zIndex: nextZIndex(objectsRef.current),
              payload: makeImagePayload(fileId, file.name),
            }),
          );
        }
      } catch (error) {
        setImportError(
          error instanceof Error ? error.message : "Image import failed",
        );
      }
    },
    [activeMode, appendObject, noteId, ownerId],
  );

  const importPdfs = useCallback(
    async (files: File[], at: Point): Promise<void> => {
      const pdfs = files.filter(
        (file) =>
          file.type === "application/pdf" ||
          file.name.toLowerCase().endsWith(".pdf"),
      );
      if (pdfs.length === 0) return;
      setImportError(null);
      try {
        const { loadPdfFile } = await import("../pdf/usePdfDocument");
        let y = at.y;
        for (const file of pdfs) {
          const pdf = await loadPdfFile(file);
          try {
            const fileId = await uploadFile(file);
            for (
              let pageNumber = 1;
              pageNumber <= pdf.numPages;
              pageNumber += 1
            ) {
              const page = await pdf.getPage(pageNumber);
              const viewport = page.getViewport({ scale: 1 });
              const width = Math.min(720, viewport.width);
              const height = width * (viewport.height / viewport.width);
              const base = makeCanvasObject({
                id: newId(),
                ownerId:
                  ownerId ?? objectsRef.current[0]?.ownerId ?? DEMO_OWNER_ID,
                noteId,
                kind: "pdf-page-reference",
                bounds: clampBoundsToMode(
                  { x: at.x, y, width, height },
                  activeMode,
                ),
                zIndex: nextZIndex(objectsRef.current),
                payload: {
                  fileId,
                  sourceNoteId: noteId,
                  pageNumber,
                  importedDocument: true,
                },
              });
              appendObject({ ...base, locked: true });
              y += height + 32;
            }
          } finally {
            await pdf.cleanup();
          }
        }
      } catch (error) {
        setImportError(
          error instanceof Error ? error.message : "PDF import failed",
        );
      }
    },
    [activeMode, appendObject, noteId, ownerId],
  );

  useEffect(() => {
    if (!importedPdf || importedPdfRef.current === importedPdf) return;
    importedPdfRef.current = importedPdf;
    onPdfImported?.();
    void importPdfs([importedPdf], { x: 0, y: 0 });
  }, [importPdfs, importedPdf, onPdfImported]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      if (isInsideEditable(event.target)) return;
      const files = [...(event.clipboardData?.files ?? [])];
      const hasImages = files.some((file) => file.type.startsWith("image/"));
      if (!hasImages) return;
      event.preventDefault();
      const at = {
        x:
          viewportRef.current.x +
          containerSize.width / viewportRef.current.zoom / 2,
        y:
          viewportRef.current.y +
          containerSize.height / viewportRef.current.zoom / 2,
      };
      void importImages(files, at);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [containerSize.height, containerSize.width, importImages]);

  const createObject = useCallback(
    (
      createTool: CreateTool,
      raw: Bounds,
      endpoints?: { start: Point; end: Point },
    ): void => {
      const bounds = clampBoundsToMode(raw, activeMode);
      const kind =
        createTool === "text"
          ? ("rich-text" as const)
          : createTool === "rectangle"
            ? ("rectangle" as const)
            : createTool === "ellipse"
              ? ("ellipse" as const)
              : createTool === "arrow"
                ? ("arrow" as const)
                : createTool === "matrix"
                  ? ("matrix" as const)
                  : ("line" as const);
      let shapePayload: CanvasObject["payload"] = {
        color: drawingStyle.strokeColor,
        strokeWidth: drawingStyle.strokeWidth,
        lineStyle: drawingStyle.lineStyle,
        ...(kind === "rectangle" || kind === "ellipse"
          ? {
              fill: drawingStyle.fillColor,
              fillOpacity: drawingStyle.fillOpacity,
            }
          : {}),
        ...(kind === "rectangle"
          ? { cornerRadius: drawingStyle.cornerRadius }
          : {}),
      };
      if ((kind === "line" || kind === "arrow") && endpoints !== undefined) {
        const dx = bounds.x - raw.x;
        const dy = bounds.y - raw.y;
        shapePayload = setLineEndpointPayload(
          { x: endpoints.start.x + dx, y: endpoints.start.y + dy },
          { x: endpoints.end.x + dx, y: endpoints.end.y + dy },
          shapePayload,
        );
      }
      const object = makeCanvasObject({
        id: newId(),
        ownerId: ownerId ?? objectsRef.current[0]?.ownerId ?? DEMO_OWNER_ID,
        noteId,
        kind,
        bounds,
        zIndex: nextZIndex(objectsRef.current),
        payload:
          createTool === "text"
            ? {
                doc: { type: "doc", content: [{ type: "paragraph" }] },
                color: drawingStyle.strokeColor,
              }
            : shapePayload,
      });
      appendObject(object);
      setTool("select");
      if (createTool === "text") selection.select(object.id);
      else selection.clear();
    },
    // Selection methods are stable; selection is excluded to avoid gesture churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeMode, ownerId, noteId, appendObject, drawingStyle],
  );

  const deleteSelection = useCallback((): void => {
    const ids = selection.selectedIds;
    if (ids.size === 0) return;
    const removed = objectsRef.current.filter(
      (object) => ids.has(object.id) && !object.locked,
    );
    const next = objectsRef.current.filter(
      (object) => !ids.has(object.id) || object.locked,
    );
    objectsRef.current = next;
    setMirror(next);
    for (const o of removed) {
      onOperationRef.current?.(
        makeDeleteOperation(o.id, o.revision, noteId, deviceIdRef.current),
      );
    }
    if (removed.length > 0) recordHistory({ before: removed, after: [] });
    selection.clear();
  }, [noteId, recordHistory, selection]);

  const [hasClipboard, setHasClipboard] = useState(
    () => canvasClipboard !== null,
  );

  /** Selected objects that selection actions may change; locked objects stay put. */
  const editableSelection = useCallback(
    (): CanvasObject[] =>
      objectsRef.current.filter(
        (object) => selection.selectedIds.has(object.id) && !object.locked,
      ),
    [selection],
  );

  /** Adds objects as one undoable step and selects them. */
  const insertObjects = useCallback(
    (inserted: CanvasObject[]): void => {
      if (inserted.length === 0) return;
      const next = [...objectsRef.current, ...inserted];
      objectsRef.current = next;
      setMirror(next);
      for (const object of inserted) commitUpsert(object);
      recordHistory({ before: [], after: inserted });
      selection.setSelection(inserted.map((object) => object.id));
    },
    [commitUpsert, recordHistory, selection],
  );

  /** Replaces existing objects as one undoable step. */
  const updateObjects = useCallback(
    (changes: { before: CanvasObject; after: CanvasObject }[]): void => {
      if (changes.length === 0) return;
      const now = new Date().toISOString();
      const after = new Map(
        changes.map(({ after: object }) => [
          object.id,
          { ...object, updatedAt: now },
        ]),
      );
      const next = objectsRef.current.map(
        (object) => after.get(object.id) ?? object,
      );
      objectsRef.current = next;
      setMirror(next);
      for (const object of after.values()) commitUpsert(object);
      recordHistory({
        before: changes.map(({ before }) => before),
        after: [...after.values()],
      });
    },
    [commitUpsert, recordHistory],
  );

  const copySelection = useCallback((): boolean => {
    const copied = editableSelection();
    if (copied.length === 0) return false;
    canvasClipboard = {
      objects: structuredClone(copied),
      sourceNoteId: noteId,
      pastes: 0,
    };
    setHasClipboard(true);
    return true;
  }, [editableSelection, noteId]);

  const cutSelection = useCallback((): boolean => {
    if (!copySelection()) return false;
    deleteSelection();
    return true;
  }, [copySelection, deleteSelection]);

  const cloneTarget = useCallback(
    (offset: Point) => ({
      ownerId: ownerId ?? objectsRef.current[0]?.ownerId ?? DEMO_OWNER_ID,
      noteId,
      offset,
      baseZIndex: nextZIndex(objectsRef.current),
    }),
    [noteId, ownerId],
  );

  const duplicateSelection = useCallback((): void => {
    const source = editableSelection();
    insertObjects(
      cloneObjects(source, cloneTarget({ x: PASTE_OFFSET, y: PASTE_OFFSET })),
    );
  }, [cloneTarget, editableSelection, insertObjects]);

  /** Pastes beside the source in the same note when visible, else at the view center. */
  const pasteClipboard = useCallback((): void => {
    const clipboard = canvasClipboard;
    const source = clipboard ? unionBounds(clipboard.objects) : null;
    if (clipboard === null || source === null) return;
    const activeViewport = viewportRef.current;
    const visible = {
      x: activeViewport.x,
      y: activeViewport.y,
      width: containerSize.width / activeViewport.zoom,
      height: containerSize.height / activeViewport.zoom,
    };
    clipboard.pastes += 1;
    const step =
      clipboard.sourceNoteId === noteId ? PASTE_OFFSET * clipboard.pastes : 0;
    const placed = { ...source, x: source.x + step, y: source.y + step };
    const offset = boundsIntersect(placed, visible)
      ? { x: step, y: step }
      : {
          x: visible.x + visible.width / 2 - (source.x + source.width / 2),
          y: visible.y + visible.height / 2 - (source.y + source.height / 2),
        };
    insertObjects(
      cloneObjects(clipboard.objects, cloneTarget(offset)).map((object) => ({
        ...object,
        bounds: clampBoundsToMode(object.bounds, activeMode),
      })),
    );
  }, [
    activeMode,
    cloneTarget,
    containerSize.height,
    containerSize.width,
    insertObjects,
    noteId,
  ]);

  const reorderSelection = useCallback(
    (direction: "front" | "back"): void => {
      const chosen = [...editableSelection()].sort(
        (a, b) => a.zIndex - b.zIndex,
      );
      if (chosen.length === 0) return;
      const others = objectsRef.current.filter(
        (object) => !chosen.some((picked) => picked.id === object.id),
      );
      const start =
        direction === "front"
          ? nextZIndex(others)
          : Math.min(0, ...others.map((object) => object.zIndex)) -
            chosen.length;
      updateObjects(
        chosen.map((before, index) => ({
          before,
          after: { ...before, zIndex: start + index },
        })),
      );
    },
    [editableSelection, updateObjects],
  );

  const nudgeSelection = useCallback(
    (dx: number, dy: number): boolean => {
      const chosen = editableSelection();
      if (chosen.length === 0) return false;
      updateObjects(
        chosen.map((before) => ({
          before,
          after: moveObjectToBounds(
            before,
            translateBoundsInMode(before.bounds, dx, dy, activeMode),
          ),
        })),
      );
      return true;
    },
    [activeMode, editableSelection, updateObjects],
  );

  // Clipboard events: copy and cut the selection; paste copied objects unless images are pasted.
  useEffect(() => {
    const hasTextSelection = (): boolean =>
      (window.getSelection()?.toString() ?? "") !== "";
    const onCopyOrCut = (event: ClipboardEvent): void => {
      if (isInsideEditable(event.target) || hasTextSelection()) return;
      const done = event.type === "cut" ? cutSelection() : copySelection();
      if (!done) return;
      event.preventDefault();
      // Replace the system clipboard so a stale image is not pasted instead.
      event.clipboardData?.setData("text/plain", "Aurora canvas objects");
    };
    const onPaste = (event: ClipboardEvent): void => {
      if (isInsideEditable(event.target) || canvasClipboard === null) return;
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.some((file) => file.type.startsWith("image/"))) return;
      event.preventDefault();
      pasteClipboard();
    };
    window.addEventListener("copy", onCopyOrCut);
    window.addEventListener("cut", onCopyOrCut);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("copy", onCopyOrCut);
      window.removeEventListener("cut", onCopyOrCut);
      window.removeEventListener("paste", onPaste);
    };
  }, [copySelection, cutSelection, pasteClipboard]);

  /** Button copy: the browser blocks clipboard events here, so clear stale text best-effort. */
  const copyFromButton = useCallback(
    (cut: boolean): void => {
      if (!(cut ? cutSelection() : copySelection())) return;
      void navigator.clipboard
        ?.writeText("Aurora canvas objects")
        .catch(() => undefined);
    },
    [copySelection, cutSelection],
  );

  // Keyboard: tool shortcuts, selection delete, and escape.
  useEffect(() => {
    const shortcuts: Record<string, CanvasTool> = {
      v: "select",
      s: "lasso",
      h: "pan",
      p: "pen",
      i: "highlighter",
      x: "eraser",
      t: "text",
      l: "line",
      r: "rectangle",
      e: "ellipse",
      a: "arrow",
      m: "matrix",
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target;
      const inEditable =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.closest('[data-rich-text-editable="true"]') !== null ||
          target.closest('[data-editing="true"]') !== null);
      if (inEditable) {
        if (e.key === "Escape") target.blur();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (e.key === "Escape") {
        if (gestureRef.current?.kind === "marquee") setActiveGesture(null);
        selection.clear();
        return;
      }
      const command = e.ctrlKey || e.metaKey;
      if (command && !e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selection.setSelection(
          objectsRef.current
            .filter((object) => !object.locked)
            .map((object) => object.id),
        );
        return;
      }
      if (command && !e.altKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      const nudge = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }[e.key];
      if (nudge !== undefined && !command && !e.altKey) {
        const step = e.shiftKey ? 10 : 1;
        if (nudgeSelection(nudge[0]! * step, nudge[1]! * step))
          e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const next = shortcuts[e.key.toLowerCase()];
      if (next) changeTool(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    changeTool,
    deleteSelection,
    duplicateSelection,
    nudgeSelection,
    redo,
    selection,
    setActiveGesture,
    undo,
  ]);

  const highlighting = tool === "highlighter";
  const inkColor = highlighting
    ? highlighterStyle.color
    : drawingStyle.strokeColor;
  const inkWidth = highlighting ? highlighterStyle.width : STROKE_TOOL_WIDTH;
  const pen = usePenCapture({
    isActive: isInkTool(tool),
    noteId,
    zoom: viewport.zoom,
    color: inkColor,
    baseWidth: inkWidth,
    highlighter: highlighting,
    containerRef,
    toCanvas,
    onStrokeComplete: (points) => {
      if (points.length < 1) return;
      const rawBounds = pointsToBounds(
        points,
        highlighting ? inkWidth : inkWidth * 2,
      );
      const bounds = clampBoundsToMode(rawBounds, activeMode);
      const storedPoints = translateStrokePoints(
        points,
        bounds.x - rawBounds.x,
        bounds.y - rawBounds.y,
      );
      const object = makeCanvasObject({
        id: newId(),
        ownerId: ownerId ?? objectsRef.current[0]?.ownerId ?? DEMO_OWNER_ID,
        noteId,
        kind: "stroke",
        bounds,
        zIndex: nextZIndex(objectsRef.current),
        payload: setStrokePayload(
          storedPoints,
          inkColor,
          inkWidth,
          highlighting,
        ),
      });
      appendObject(object);
    },
  });

  const eraseStrokeAt = useCallback(
    (point: Point, removed: Map<string, CanvasObject>): void => {
      const hit = hitTestTopmostStroke(
        objectsRef.current,
        point,
        ERASER_HIT_TOLERANCE_SCREEN / viewportRef.current.zoom,
      );
      if (hit === null || removed.has(hit.id)) return;
      removed.set(hit.id, hit);
      const next = objectsRef.current.filter((object) => object.id !== hit.id);
      objectsRef.current = next;
      setMirror(next);
    },
    [],
  );

  const eraseStrokeBetween = useCallback(
    (start: Point, end: Point, removed: Map<string, CanvasObject>): void => {
      const tolerance = ERASER_HIT_TOLERANCE_SCREEN / viewportRef.current.zoom;
      const distance = Math.hypot(end.x - start.x, end.y - start.y);
      const steps = Math.max(1, Math.ceil(distance / tolerance));
      for (let index = 1; index <= steps; index += 1) {
        eraseStrokeAt(
          {
            x: start.x + ((end.x - start.x) * index) / steps,
            y: start.y + ((end.y - start.y) * index) / steps,
          },
          removed,
        );
      }
    },
    [eraseStrokeAt],
  );

  // ---- Pointer gestures ----------------------------------------------------

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      const screen: Point = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      if (e.pointerType === "pen") {
        lastStylusTimeRef.current = e.timeStamp;
        pinchRef.current.clear();
        pinchSpanRef.current = null;
        if (gestureRef.current?.kind === "pan") setActiveGesture(null);
      }
      if (
        shouldRejectTouch(e.pointerType, e.timeStamp, lastStylusTimeRef.current)
      ) {
        return;
      }

      const touchTarget = e.target instanceof Element ? e.target : null;
      const touchPrimary = objectsRef.current.find((o) => o.id === primaryId);
      const touchHandle =
        tool === "select" &&
        touchPrimary &&
        !touchPrimary.locked &&
        touchPrimary.kind !== "stroke"
          ? handleAtPoint(
              touchPrimary.bounds,
              screenToCanvas(screen, viewportRef.current),
              HANDLE_HIT_TOLERANCE_SCREEN / viewportRef.current.zoom,
            )
          : null;
      const touchChrome =
        tool === "select" &&
        (touchHandle !== null ||
          touchTarget?.closest('[data-move-grip="true"]'));
      if (
        e.pointerType === "touch" &&
        isInsideEditable(e.target) &&
        !touchChrome
      )
        return;
      if (e.pointerType === "touch" && !touchChrome) {
        if (pen.isDrawing()) return;
        stopMomentum();
        pinchRef.current.set(e.pointerId, screen);
        if (pinchRef.current.size === 2) {
          const [a, b] = [...pinchRef.current.values()];
          if (a === undefined || b === undefined) return;
          pinchSpanRef.current = {
            distance: Math.hypot(b.x - a.x, b.y - a.y),
            mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            zoom: viewportRef.current.zoom,
          };
          touchPanRef.current = null;
          setActiveGesture(null);
        } else if (pinchRef.current.size === 1) {
          touchPanRef.current = {
            point: screen,
            time: e.timeStamp,
            velocity: { x: 0, y: 0 },
          };
          setActiveGesture({ kind: "pan", lastScreen: screen });
        }
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Pointer capture is best-effort.
        }
        return;
      }

      if (
        isInkTool(tool) &&
        (e.pointerType === "pen" ||
          (e.pointerType === "mouse" && e.button === 0))
      ) {
        pinchRef.current.clear();
        pinchSpanRef.current = null;
        setPlacementPropertiesOpen(false);
        setActiveGesture(null);
        return;
      }

      if (tool === "pan" || (e.pointerType === "mouse" && e.button === 1)) {
        setActiveGesture({ kind: "pan", lastScreen: screen });
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Pointer capture is best-effort.
        }
        return;
      }
      if (e.pointerType === "mouse" && e.button !== 0) return;

      const targetElement = e.target instanceof Element ? e.target : null;
      const moveGrip = targetElement?.closest('[data-move-grip="true"]');
      const gripId = moveGrip
        ?.closest("[data-html-object]")
        ?.getAttribute("data-html-object");
      const canvasPoint = screenToCanvas(screen, viewportRef.current);

      if (tool !== "select" && isInsideEditable(e.target)) return;

      const capturePointer = (): void => {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Pointer capture is best-effort.
        }
      };
      /** Drags the whole selection when the press lands inside its bounds. */
      const startSelectionMove = (): boolean => {
        const selected = objectsRef.current.filter(
          (object) => selection.selectedIds.has(object.id) && !object.locked,
        );
        const bounds = unionBounds(selected);
        if (bounds === null || !boundsContainPoint(bounds, canvasPoint))
          return false;
        e.preventDefault();
        capturePointer();
        setActiveGesture({
          kind: "move",
          ids: selected.map((object) => object.id),
          start: canvasPoint,
          origins: new Map(
            selected.map((object) => [object.id, object.bounds]),
          ),
        });
        return true;
      };
      const startMarquee = (
        shape: "box" | "lasso",
        additive: boolean,
      ): void => {
        e.preventDefault();
        capturePointer();
        const base = additive ? [...selection.selectedIds] : [];
        if (!additive) selection.clear();
        setActiveGesture({
          kind: "marquee",
          shape,
          points: [canvasPoint],
          base,
        });
      };

      if (tool === "lasso") {
        if (!e.shiftKey && startSelectionMove()) return;
        startMarquee("lasso", e.shiftKey);
        return;
      }

      if (tool === "eraser") {
        const removed = new Map<string, CanvasObject>();
        setActiveGesture({ kind: "erase", last: canvasPoint, removed });
        eraseStrokeAt(canvasPoint, removed);
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Pointer capture is best-effort.
        }
        return;
      }

      if (tool === "select") {
        const primary =
          objectsRef.current.find((o) => o.id === primaryId) ?? null;
        if (
          primary !== null &&
          !primary.locked &&
          primary.kind !== "stroke" &&
          selection.selectedIds.size === 1
        ) {
          const handle = handleAtPoint(
            primary.bounds,
            canvasPoint,
            HANDLE_HIT_TOLERANCE_SCREEN / viewportRef.current.zoom,
          );
          if (handle !== null && !moveGrip) {
            e.preventDefault();
            setActiveGesture({
              kind: "resize",
              id: primary.id,
              handle,
              start: canvasPoint,
              startBounds: primary.bounds,
              startObject: primary,
            });
            try {
              el.setPointerCapture(e.pointerId);
            } catch {
              // Pointer capture is best-effort.
            }
            return;
          }
        }
        if (isInsideEditable(e.target) && !moveGrip) return;
        const hit =
          (gripId
            ? objectsRef.current.find((o) => o.id === gripId && !o.locked)
            : null) ??
          hitTestTopmost(
            objectsRef.current.filter(
              (object) =>
                !object.locked &&
                (object.kind !== "stroke" ||
                  hitTestTopmostStroke(
                    [object],
                    canvasPoint,
                    HANDLE_HIT_TOLERANCE_SCREEN / viewportRef.current.zoom,
                  ) !== null) &&
                ((object.kind !== "line" && object.kind !== "arrow") ||
                  hitTestLineObject(
                    object,
                    canvasPoint,
                    HANDLE_HIT_TOLERANCE_SCREEN / viewportRef.current.zoom,
                  )),
            ),
            canvasPoint,
          );
        if (hit === null) {
          if (!e.shiftKey && startSelectionMove()) return;
          startMarquee("box", e.shiftKey);
          return;
        }
        const alreadySelected = selection.selectedIds.has(hit.id);
        if (e.shiftKey || !alreadySelected)
          selection.select(hit.id, e.shiftKey);
        const previous = [...selection.selectedIds];
        const moveIds = e.shiftKey
          ? alreadySelected
            ? previous.filter((id) => id !== hit.id)
            : [...previous, hit.id]
          : alreadySelected
            ? previous
            : [hit.id];
        const origins = new Map<string, Bounds>();
        for (const id of moveIds) {
          const o = objectsRef.current.find((c) => c.id === id);
          if (o !== undefined && !o.locked) origins.set(id, o.bounds);
        }
        if (origins.size > 0) {
          e.preventDefault();
          try {
            el.setPointerCapture(e.pointerId);
          } catch {
            // Pointer capture is best-effort.
          }
          setActiveGesture({
            kind: "move",
            ids: [...origins.keys()],
            start: canvasPoint,
            origins,
          });
        }
        return;
      }

      if (isCreateTool(tool)) {
        setPlacementPropertiesOpen(false);
        setActiveGesture({
          kind: "create",
          tool,
          start: canvasPoint,
          current: canvasPoint,
          snapTo45: false,
        });
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Pointer capture is best-effort.
        }
      }
    },
    [
      tool,
      primaryId,
      createObject,
      eraseStrokeAt,
      pen,
      setActiveGesture,
      selection,
      stopMomentum,
    ],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      const screen: Point = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
      if (e.pointerType === "pen") lastStylusTimeRef.current = e.timeStamp;
      if (
        shouldRejectTouch(e.pointerType, e.timeStamp, lastStylusTimeRef.current)
      ) {
        pinchRef.current.delete(e.pointerId);
        if (pinchRef.current.size < 2) pinchSpanRef.current = null;
        return;
      }
      setEraserPointer(
        tool === "eraser" && e.pointerType !== "touch" ? screen : null,
      );

      if (e.pointerType === "touch" && pinchRef.current.has(e.pointerId)) {
        pinchRef.current.set(e.pointerId, screen);
        if (pinchRef.current.size === 2 && pinchSpanRef.current !== null) {
          const [a, b] = [...pinchRef.current.values()];
          if (a === undefined || b === undefined) return;
          const distance = Math.hypot(b.x - a.x, b.y - a.y);
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const prev = pinchSpanRef.current;
          let nextZoom = prev.zoom;
          if (distance > 0 && prev.distance > 0) {
            nextZoom = prev.zoom * (distance / prev.distance);
            zoomAt(mid, nextZoom);
          }
          panBy(mid.x - prev.mid.x, mid.y - prev.mid.y);
          pinchSpanRef.current = { distance, mid, zoom: nextZoom };
        } else if (pinchRef.current.size === 1) {
          pinchSpanRef.current = null;
          if (!pen.isDrawing()) {
            const current = gestureRef.current;
            if (current?.kind === "pan") {
              panBy(
                screen.x - current.lastScreen.x,
                screen.y - current.lastScreen.y,
              );
              const sample = touchPanRef.current;
              if (sample !== null) {
                const elapsed = e.timeStamp - sample.time;
                if (elapsed > 0) {
                  const weight = Math.min(1, elapsed / 32);
                  touchPanRef.current = {
                    point: screen,
                    time: e.timeStamp,
                    velocity: {
                      x:
                        sample.velocity.x * (1 - weight) +
                        ((screen.x - sample.point.x) / elapsed) * weight,
                      y:
                        sample.velocity.y * (1 - weight) +
                        ((screen.y - sample.point.y) / elapsed) * weight,
                    },
                  };
                }
              }
            }
            setActiveGesture({ kind: "pan", lastScreen: screen });
          }
        }
        return;
      }

      if (isInkTool(tool)) return;
      const current = gestureRef.current;
      if (current === null) return;

      if (current.kind === "pan") {
        panBy(screen.x - current.lastScreen.x, screen.y - current.lastScreen.y);
        setActiveGesture({ kind: "pan", lastScreen: screen });
        return;
      }

      const canvasPoint = screenToCanvas(screen, viewportRef.current);
      if (current.kind === "erase") {
        eraseStrokeBetween(current.last, canvasPoint, current.removed);
        current.last = canvasPoint;
        return;
      }
      if (current.kind === "marquee") {
        const first = current.points[0]!;
        const last = current.points.at(-1)!;
        if (current.shape === "box") {
          setActiveGesture({ ...current, points: [first, canvasPoint] });
        } else if (
          Math.hypot(canvasPoint.x - last.x, canvasPoint.y - last.y) *
            viewportRef.current.zoom >=
          2
        ) {
          setActiveGesture({
            ...current,
            points: [...current.points, canvasPoint],
          });
        }
        return;
      }
      if (current.kind === "move") {
        const dx = canvasPoint.x - current.start.x;
        const dy = canvasPoint.y - current.start.y;
        const next = objectsRef.current.map((o) => {
          const origin = current.origins.get(o.id);
          if (origin === undefined) return o;
          return moveObjectToBounds(
            o,
            translateBoundsInMode(origin, dx, dy, activeMode),
          );
        });
        objectsRef.current = next;
        setMirror(next);
        return;
      }
      if (current.kind === "resize") {
        const next = resizeBoundsInMode(
          current.startBounds,
          current.handle,
          current.start,
          canvasPoint,
          activeMode,
        );
        const resized = objectsRef.current.map((o) =>
          o.id === current.id
            ? resizeObjectToBounds(
                { ...current.startObject, payload: o.payload },
                next,
              )
            : o,
        );
        objectsRef.current = resized;
        setMirror(resized);
        return;
      }
      setActiveGesture({
        ...current,
        current: canvasPoint,
        snapTo45:
          (current.tool === "line" || current.tool === "arrow") && e.shiftKey,
      });
    },
    [
      activeMode,
      eraseStrokeBetween,
      panBy,
      pen,
      setActiveGesture,
      tool,
      zoomAt,
    ],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "pen") lastStylusTimeRef.current = e.timeStamp;
      if (
        shouldRejectTouch(e.pointerType, e.timeStamp, lastStylusTimeRef.current)
      ) {
        pinchRef.current.delete(e.pointerId);
        if (pinchRef.current.size < 2) pinchSpanRef.current = null;
        return;
      }
      if (e.pointerType === "touch" && pinchRef.current.has(e.pointerId)) {
        const wasPinching = pinchSpanRef.current !== null;
        pinchRef.current.delete(e.pointerId);
        pinchSpanRef.current = null;
        const remaining = [...pinchRef.current.values()][0];
        setActiveGesture(
          remaining !== undefined && !pen.isDrawing()
            ? { kind: "pan", lastScreen: remaining }
            : null,
        );
        if (remaining !== undefined) {
          touchPanRef.current = {
            point: remaining,
            time: e.timeStamp,
            velocity: { x: 0, y: 0 },
          };
        } else {
          if (
            !wasPinching &&
            touchPanRef.current !== null &&
            e.timeStamp - touchPanRef.current.time < 80
          ) {
            startMomentum(touchPanRef.current.velocity);
          }
          touchPanRef.current = null;
        }
        return;
      }
      const current = gestureRef.current;
      setActiveGesture(null);
      if (current === null) return;

      if (current.kind === "marquee") {
        const first = current.points[0]!;
        const extent =
          current.points.reduce(
            (max, point) =>
              Math.max(max, Math.hypot(point.x - first.x, point.y - first.y)),
            0,
          ) * viewportRef.current.zoom;
        // A click on empty space: the selection was already cleared unless Shift kept it.
        if (extent < MARQUEE_MIN_SCREEN) return;
        const polygon =
          current.shape === "box"
            ? boxPolygon(first, current.points.at(-1)!)
            : current.points;
        const hits = objectsInRegion(objectsRef.current, polygon);
        selection.setSelection([
          ...current.base,
          ...hits.map((object) => object.id),
        ]);
        return;
      }

      if (current.kind === "erase") {
        const rect = e.currentTarget.getBoundingClientRect();
        eraseStrokeBetween(
          current.last,
          screenToCanvas(
            { x: e.clientX - rect.left, y: e.clientY - rect.top },
            viewportRef.current,
          ),
          current.removed,
        );
        const removed = [...current.removed.values()];
        for (const object of removed) {
          onOperationRef.current?.(
            makeDeleteOperation(
              object.id,
              object.revision,
              noteId,
              deviceIdRef.current,
            ),
          );
        }
        if (removed.length > 0) {
          recordHistory({ before: removed, after: [] });
          selection.clear();
        }
        return;
      }
      if (current.kind === "move") {
        const before: CanvasObject[] = [];
        const after: CanvasObject[] = [];
        for (const o of objectsRef.current) {
          const origin = current.origins.get(o.id);
          if (origin === undefined) continue;
          if (o.bounds.x === origin.x && o.bounds.y === origin.y) continue;
          const moved = { ...o, updatedAt: new Date().toISOString() };
          before.push(moveObjectToBounds(o, origin));
          after.push(moved);
          commitUpsert(moved);
        }
        if (after.length > 0) recordHistory({ before, after });
        return;
      }
      if (current.kind === "resize") {
        const o = objectsRef.current.find((c) => c.id === current.id);
        if (
          o !== undefined &&
          (o.bounds.x !== current.startBounds.x ||
            o.bounds.y !== current.startBounds.y ||
            o.bounds.width !== current.startBounds.width ||
            o.bounds.height !== current.startBounds.height)
        ) {
          const resized = { ...o, updatedAt: new Date().toISOString() };
          commitUpsert(resized);
          recordHistory({ before: [current.startObject], after: [resized] });
        }
        return;
      }
      if (current.kind === "create") {
        const rect = e.currentTarget.getBoundingClientRect();
        const end = screenToCanvas(
          { x: e.clientX - rect.left, y: e.clientY - rect.top },
          viewportRef.current,
        );
        if (current.tool === "line" || current.tool === "arrow") {
          const geometry = lineGeometryFromDrag(
            current.start,
            end,
            e.shiftKey || current.snapTo45,
            current.tool === "arrow"
              ? Math.max(10, drawingStyle.strokeWidth)
              : drawingStyle.strokeWidth / 2,
          );
          if (
            Math.hypot(
              geometry.end.x - geometry.start.x,
              geometry.end.y - geometry.start.y,
            ) >= 2
          ) {
            createObject(current.tool, geometry.bounds, geometry);
          }
          return;
        }
        const raw = dragBoundsFree(current.start, end);
        if (raw.width >= 2 || raw.height >= 2) createObject(current.tool, raw);
      }
    },
    [
      commitUpsert,
      createObject,
      eraseStrokeBetween,
      noteId,
      pen,
      recordHistory,
      selection,
      setActiveGesture,
      startMomentum,
    ],
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "pen") lastStylusTimeRef.current = e.timeStamp;
      if (
        shouldRejectTouch(e.pointerType, e.timeStamp, lastStylusTimeRef.current)
      ) {
        pinchRef.current.delete(e.pointerId);
        if (pinchRef.current.size < 2) pinchSpanRef.current = null;
        return;
      }
      if (e.pointerType === "touch" && pinchRef.current.has(e.pointerId)) {
        pinchRef.current.delete(e.pointerId);
        if (pinchRef.current.size < 2) pinchSpanRef.current = null;
        touchPanRef.current = null;
        setActiveGesture(null);
        return;
      }
      const current = gestureRef.current;
      if (current?.kind === "erase") {
        const next = [...objectsRef.current, ...current.removed.values()];
        objectsRef.current = next;
        setMirror(next);
      } else if (current?.kind === "move") {
        // Roll back to gesture-start positions; nothing was committed.
        const next = objectsRef.current.map((o) => {
          const origin = current.origins.get(o.id);
          return origin === undefined ? o : moveObjectToBounds(o, origin);
        });
        objectsRef.current = next;
        setMirror(next);
      } else if (current?.kind === "resize") {
        const next = objectsRef.current.map((o) =>
          o.id === current.id ? current.startObject : o,
        );
        objectsRef.current = next;
        setMirror(next);
      }
      setActiveGesture(null);
    },
    [setActiveGesture],
  );

  const updateObjectWithPayload = useCallback(
    (o: CanvasObject, payloadPatch: Record<string, unknown>): void => {
      const next = {
        ...o,
        payload: { ...o.payload, ...payloadPatch },
        updatedAt: new Date().toISOString(),
      };
      const objects = objectsRef.current.map((current) =>
        current.id === next.id ? next : current,
      );
      objectsRef.current = objects;
      setMirror(objects);
      commitUpsert(next);
    },
    [commitUpsert],
  );

  const previewSelectedShapeStyle = useCallback(
    (patch: Partial<DrawingStyle>): void => {
      const object =
        objectsRef.current.find((item) => item.id === primaryId) ?? null;
      if (!isVectorObject(object)) return;
      const payload = {
        ...object.payload,
        ...(patch.strokeColor !== undefined
          ? { color: patch.strokeColor }
          : {}),
        ...(patch.fillColor !== undefined || "fillColor" in patch
          ? { fill: patch.fillColor }
          : {}),
        ...(patch.fillOpacity !== undefined
          ? { fillOpacity: patch.fillOpacity }
          : {}),
        ...(patch.strokeWidth !== undefined
          ? { strokeWidth: patch.strokeWidth }
          : {}),
        ...(patch.lineStyle !== undefined
          ? { lineStyle: patch.lineStyle }
          : {}),
        ...(patch.cornerRadius !== undefined
          ? { cornerRadius: patch.cornerRadius }
          : {}),
      };
      if (JSON.stringify(payload) === JSON.stringify(object.payload)) return;
      if (shapeEditOriginRef.current === null) {
        shapeEditOriginRef.current = object;
      }
      const updated = {
        ...object,
        payload,
        updatedAt: new Date().toISOString(),
      };
      const next = objectsRef.current.map((item) =>
        item.id === object.id ? updated : item,
      );
      objectsRef.current = next;
      setMirror(next);
      commitUpsert(updated);
    },
    [commitUpsert, primaryId],
  );

  const commitSelectedShapeStyle = useCallback((): void => {
    const before = shapeEditOriginRef.current;
    shapeEditOriginRef.current = null;
    if (before === null) return;
    const current = objectsRef.current.find((item) => item.id === before.id);
    if (
      current === undefined ||
      JSON.stringify(current.payload) === JSON.stringify(before.payload)
    ) {
      return;
    }
    recordHistory({ before: [before], after: [current] });
  }, [recordHistory]);

  useEffect(() => {
    commitSelectedShapeStyle();
    setShapePropertiesOpen(false);
  }, [commitSelectedShapeStyle, primaryId, tool]);

  const selectedDrawingStyle = isVectorObject(primaryObject)
    ? drawingStyleFromObject(primaryObject)
    : null;

  const htmlCallbacks = useMemo<HtmlObjectCallbacks>(
    () => ({
      onRichTextChange: (id, doc) => {
        const o = objectsRef.current.find((c) => c.id === id);
        if (o === undefined) return;
        updateObjectWithPayload(o, { doc });
      },
      onStickyTextChange: (id, text) => {
        const o = objectsRef.current.find((c) => c.id === id);
        if (o === undefined) return;
        updateObjectWithPayload(o, { text });
      },
    }),
    // updateObjectWithPayload only depends on stable callbacks; keep the memo stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [updateObjectWithPayload],
  );

  // ---- Rendering -----------------------------------------------------------

  const zoom = viewport.zoom;
  const view: Bounds = {
    x: viewport.x,
    y: viewport.y,
    width: containerSize.width > 0 ? containerSize.width / zoom : 0,
    height: containerSize.height > 0 ? containerSize.height / zoom : 0,
  };
  const scrollBounds = useMemo(
    () =>
      canvasScrollBounds(
        displayObjects,
        activeMode,
        view.width,
        view.height,
        pageCount,
      ),
    [displayObjects, activeMode, view.width, view.height, pageCount],
  );
  const initializedModeRef = useRef("");

  useLayoutEffect(() => {
    if (scrollBounds === null) return;
    const identity = `${noteId}:${activeMode}`;
    const shouldInitialize = initializedModeRef.current !== identity;
    if (shouldInitialize) initializedModeRef.current = identity;
    const saved = shouldInitialize ? readSavedViewport(noteId) : null;
    setViewport((current) => {
      if (saved !== null) return { ...current, ...saved };
      const nextX = shouldInitialize
        ? (scrollBounds.contentWidth - view.width) / 2
        : Math.max(scrollBounds.minX, Math.min(current.x, scrollBounds.maxX));
      const preferredTop = -80 / current.zoom;
      const nextY = shouldInitialize
        ? Math.max(scrollBounds.minY, preferredTop)
        : Math.max(scrollBounds.minY, Math.min(current.y, scrollBounds.maxY));
      return nextX === current.x && nextY === current.y
        ? current
        : { ...current, x: nextX, y: nextY };
    });
  }, [
    activeMode,
    noteId,
    scrollBounds,
    setViewport,
    view.width,
    viewport.x,
    viewport.y,
  ]);

  useEffect(() => {
    if (initializedModeRef.current === `${noteId}:${activeMode}`) {
      saveViewport(noteId, viewport);
    }
  }, [activeMode, noteId, viewport]);
  const inView = queryVisibleObjects(displayObjects, view, DEFAULT_OVERSCAN);
  const visibleIds = new Set(inView.map((object) => object.id));
  // PDF pages mount a full screen ahead in every direction so they render before scrolling reaches them.
  const nearbyPdfPages = queryVisibleObjects(
    displayObjects.filter(
      (object) =>
        object.kind === "pdf-page-reference" && !visibleIds.has(object.id),
    ),
    view,
    Math.max(DEFAULT_OVERSCAN, view.width, view.height),
  );
  // Keep selected editors mounted when scrolling so their selection and undo survive.
  const visible = sortByZIndex([
    ...inView,
    ...nearbyPdfPages,
    ...displayObjects.filter(
      (object) =>
        object.kind === "rich-text" &&
        selection.isSelected(object.id) &&
        !visibleIds.has(object.id),
    ),
  ]);
  const surfaceFrames = canvasSurfaceFrames(
    displayObjects,
    activeMode,
    undefined,
    undefined,
    pageCount,
  );
  const pageBackgroundStyle = getBackgroundStyle(
    background ?? DEFAULT_BACKGROUND,
    { x: 0, y: 0, width: 0, height: 0, zoom: 1 },
  );

  const cursor =
    gesture?.kind === "pan"
      ? "panning"
      : tool === "pan"
        ? "pan"
        : isInkTool(tool)
          ? "pen"
          : tool === "eraser"
            ? "eraser"
            : tool === "select"
              ? "default"
              : "create";

  // In-progress creation preview.
  let previewShape: CanvasObject | null = null;
  let previewTextBounds: Bounds | null = null;
  if (gesture?.kind === "create") {
    const lineGeometry =
      gesture.tool === "line" || gesture.tool === "arrow"
        ? lineGeometryFromDrag(
            gesture.start,
            gesture.current,
            gesture.snapTo45,
            gesture.tool === "arrow"
              ? Math.max(10, drawingStyle.strokeWidth)
              : drawingStyle.strokeWidth / 2,
          )
        : null;
    const raw =
      lineGeometry?.bounds ?? dragBoundsFree(gesture.start, gesture.current);
    if (gesture.tool === "text") {
      previewTextBounds = raw;
    } else {
      let payload: CanvasObject["payload"] = {
        color: drawingStyle.strokeColor,
        strokeWidth: drawingStyle.strokeWidth,
        lineStyle: drawingStyle.lineStyle,
        ...(gesture.tool === "rectangle" || gesture.tool === "ellipse"
          ? {
              fill: drawingStyle.fillColor,
              fillOpacity: drawingStyle.fillOpacity,
            }
          : {}),
        ...(gesture.tool === "rectangle"
          ? { cornerRadius: drawingStyle.cornerRadius }
          : {}),
      };
      if (lineGeometry !== null) {
        payload = setLineEndpointPayload(
          lineGeometry.start,
          lineGeometry.end,
          payload,
        );
      }
      previewShape = makeCanvasObject({
        id: "preview",
        ownerId: DEMO_OWNER_ID,
        noteId,
        kind: gesture.tool,
        bounds: raw,
        zIndex: 0,
        payload,
      });
    }
  }

  const placementTool =
    isInkTool(tool) || tool === "text" || isVectorTool(tool) ? tool : null;
  const currentPageIndex = Math.max(
    0,
    Math.min(
      pageCount - 1,
      Math.floor(
        (viewport.y + view.height / 2 + PAGE_GAP) / (PAGE_HEIGHT + PAGE_GAP),
      ),
    ),
  );
  const addPageBelow = async (): Promise<void> => {
    setImportError(null);
    try {
      await syncEngine.flushNow(noteId);
      const result = await createPersistedPageBelow(noteId, currentPageIndex);
      setPageCount(result.pageCount);
      setViewport((current) => ({
        ...current,
        y: result.page.pageIndex * (PAGE_HEIGHT + PAGE_GAP) - 40 / current.zoom,
      }));
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Could not create page",
      );
    }
  };
  const selectedObjects = displayObjects.filter(
    (object) => selection.isSelected(object.id) && !object.locked,
  );
  const selectionBounds = unionBounds(selectedObjects);
  let selectionActions: {
    placement: "up" | "down";
    position: { left: number; top: number };
  } | null = null;
  if (
    (tool === "select" || tool === "lasso") &&
    gesture === null &&
    selectionBounds !== null
  ) {
    const center =
      (selectionBounds.x + selectionBounds.width / 2 - viewport.x) * zoom;
    const top = (selectionBounds.y - viewport.y) * zoom;
    const bottom =
      (selectionBounds.y + selectionBounds.height - viewport.y) * zoom;
    const placement = top >= SELECTION_ACTIONS_MIN_TOP ? "up" : "down";
    const halfWidth = Math.min(containerSize.width / 2, 200);
    selectionActions = {
      placement,
      position: {
        left: Math.max(
          halfWidth,
          Math.min(containerSize.width - halfWidth, center),
        ),
        top:
          placement === "up"
            ? Math.min(top - SELECTION_ACTIONS_GAP, containerSize.height - 12)
            : Math.max(
                76,
                Math.min(
                  bottom + SELECTION_ACTIONS_GAP,
                  containerSize.height - 56,
                ),
              ),
      },
    };
  }
  const marquee = gesture?.kind === "marquee" ? gesture : null;
  const marqueeBox =
    marquee?.shape === "box"
      ? dragBoundsFree(marquee.points[0]!, marquee.points.at(-1)!)
      : null;

  return (
    <div
      className="canvas-workspace"
      data-mode={activeMode}
      data-testid="canvas-workspace"
    >
      <div
        ref={containerRef}
        className="canvas-viewport"
        data-cursor={cursor}
        data-tool={tool}
        onPointerDown={(e) => {
          pen.handlers.onPointerDown(e);
          handlePointerDown(e);
        }}
        onPointerMove={(e) => {
          pen.handlers.onPointerMove(e);
          if (!pen.isDrawing()) handlePointerMove(e);
        }}
        onPointerUp={(e) => {
          pen.handlers.onPointerUp(e);
          handlePointerUp(e);
        }}
        onPointerCancel={(e) => {
          pen.handlers.onPointerCancel(e);
          handlePointerCancel(e);
          setEraserPointer(null);
        }}
        onPointerLeave={() => setEraserPointer(null)}
        onDragOver={(event) => {
          if (
            [...event.dataTransfer.items].some((item) =>
              item.type.startsWith("image/"),
            )
          ) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(event) => {
          const files = [...event.dataTransfer.files];
          const hasImages = files.some((file) =>
            file.type.startsWith("image/"),
          );
          if (!hasImages) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          const at = screenToCanvas(
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            viewportRef.current,
          );
          void importImages(files, at);
        }}
      >
        {activeMode === "infinite" ? (
          <div
            className="canvas-background"
            style={getBackgroundStyle(
              background ?? DEFAULT_BACKGROUND,
              viewport,
            )}
          />
        ) : null}
        <div
          className="canvas-world"
          style={{
            transform: `translate(${-viewport.x * zoom}px, ${-viewport.y * zoom}px) scale(${zoom})`,
          }}
        >
          {surfaceFrames.map((frame, index) => (
            <div
              key={index}
              className="canvas-page-frame"
              data-canvas-mode={activeMode}
              style={{
                left: frame.x,
                top: frame.y,
                width: frame.width,
                height: frame.height,
                ...pageBackgroundStyle,
              }}
            >
              {activeMode === "paged" ? (
                <span className="canvas-page-frame-label">
                  Page {index + 1}
                </span>
              ) : null}
            </div>
          ))}

          {visible
            .filter(
              (object) =>
                object.kind === "image" || object.kind === "pdf-page-reference",
            )
            .map((object) => (
              <HtmlObject
                key={object.id}
                object={object}
                interactive={tool === "select" && !object.locked}
                selected={selection.isSelected(object.id)}
                callbacks={htmlCallbacks}
              />
            ))}

          {view.width > 0 && view.height > 0 ? (
            <svg
              className="canvas-scene"
              style={{
                left: view.x,
                top: view.y,
                width: view.width,
                height: view.height,
              }}
              viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
            >
              {visible.map((o) =>
                o.kind === "stroke" ||
                o.kind === "rectangle" ||
                o.kind === "ellipse" ||
                o.kind === "line" ||
                o.kind === "arrow" ||
                o.kind === "matrix" ? (
                  <SceneObject key={o.id} object={o} />
                ) : null,
              )}
              {previewShape !== null ? (
                <SceneObject object={previewShape} />
              ) : null}
            </svg>
          ) : null}

          {previewTextBounds !== null ? (
            <div
              className="canvas-create-preview"
              style={{
                left: previewTextBounds.x,
                top: previewTextBounds.y,
                width: previewTextBounds.width,
                height: previewTextBounds.height,
              }}
            />
          ) : null}

          {visible
            .filter(
              (o) =>
                o.kind !== "stroke" &&
                o.kind !== "image" &&
                o.kind !== "rectangle" &&
                o.kind !== "ellipse" &&
                o.kind !== "line" &&
                o.kind !== "arrow" &&
                o.kind !== "matrix" &&
                o.kind !== "pdf-page-reference",
            )
            .map((o) => (
              <HtmlObject
                key={o.id}
                object={o}
                interactive={tool === "select" && !o.locked}
                selected={selection.isSelected(o.id)}
                callbacks={htmlCallbacks}
              />
            ))}
          {view.width > 0 && view.height > 0 ? (
            <svg
              className="canvas-scene canvas-selection-layer"
              style={{
                left: view.x,
                top: view.y,
                width: view.width,
                height: view.height,
              }}
              viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
            >
              {[...selection.selectedIds].map((id) => {
                const o = displayObjects.find((c) => c.id === id);
                if (o === undefined) return null;
                return (
                  <rect
                    key={`outline-${o.id}`}
                    className="canvas-selection-outline"
                    x={o.bounds.x}
                    y={o.bounds.y}
                    width={o.bounds.width}
                    height={o.bounds.height}
                    rx={6 / zoom}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
              {selectedObjects.length > 1 && selectionBounds !== null ? (
                <rect
                  className="canvas-selection-group"
                  x={selectionBounds.x - 6 / zoom}
                  y={selectionBounds.y - 6 / zoom}
                  width={selectionBounds.width + 12 / zoom}
                  height={selectionBounds.height + 12 / zoom}
                  rx={8 / zoom}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              {marqueeBox !== null ? (
                <rect
                  className="canvas-marquee"
                  x={marqueeBox.x}
                  y={marqueeBox.y}
                  width={marqueeBox.width}
                  height={marqueeBox.height}
                  rx={3 / zoom}
                  vectorEffect="non-scaling-stroke"
                />
              ) : marquee !== null ? (
                <polygon
                  className="canvas-marquee"
                  data-shape="lasso"
                  points={marquee.points
                    .map((point) => `${point.x},${point.y}`)
                    .join(" ")}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              {primaryObject !== null &&
              !primaryObject.locked &&
              primaryObject.kind !== "stroke" &&
              selectedObjects.length === 1 &&
              tool === "select"
                ? handlePositions(primaryObject.bounds).map(
                    ({ handle, point }) => (
                      <circle
                        key={handle}
                        data-handle={handle}
                        className="canvas-selection-handle"
                        cx={point.x}
                        cy={point.y}
                        r={HANDLE_SCREEN_SIZE / 2 / zoom}
                        vectorEffect="non-scaling-stroke"
                      />
                    ),
                  )
                : null}
            </svg>
          ) : null}
        </div>
        <canvas
          ref={pen.previewRef}
          className="canvas-ink-preview"
          aria-hidden="true"
        />
        {importError !== null ? (
          <button
            type="button"
            className="canvas-import-error"
            role="alert"
            onClick={() => setImportError(null)}
          >
            {importError}
          </button>
        ) : null}
        {tool === "eraser" && eraserPointer !== null ? (
          <span
            className="canvas-eraser-preview"
            style={{ left: eraserPointer.x, top: eraserPointer.y }}
          />
        ) : null}
        {activeMode === "paged" &&
        !displayObjects.some(
          (object) =>
            object.kind === "pdf-page-reference" &&
            object.payload.importedDocument === true,
        ) ? (
          <button
            type="button"
            className="canvas-add-page"
            data-canvas-controls="true"
            onClick={() => void addPageBelow()}
          >
            <Plus size={16} /> Add page below page {currentPageIndex + 1}
          </button>
        ) : null}
        {selectionActions !== null ? (
          <SelectionActions
            count={selectedObjects.length}
            position={selectionActions.position}
            placement={selectionActions.placement}
            onCopy={() => copyFromButton(false)}
            onCut={() => copyFromButton(true)}
            onDuplicate={duplicateSelection}
            onBringToFront={() => reorderSelection("front")}
            onSendToBack={() => reorderSelection("back")}
            onDelete={deleteSelection}
          >
            {selectedObjects.length === 1 && selectedDrawingStyle !== null ? (
              <>
                <span className="selection-actions-divider" />
                <ShapePropertiesButton
                  open={shapePropertiesOpen}
                  onToggle={() => setShapePropertiesOpen((current) => !current)}
                />
              </>
            ) : null}
            {shapePropertiesOpen &&
            selectedObjects.length === 1 &&
            selectedDrawingStyle !== null &&
            isVectorObject(primaryObject) ? (
              <div
                className="shape-properties-popover"
                role="group"
                aria-label="Selected shape properties"
                style={{
                  maxHeight: Math.max(
                    180,
                    selectionActions.placement === "up"
                      ? selectionActions.position.top - 72
                      : containerSize.height -
                          selectionActions.position.top -
                          72,
                  ),
                }}
              >
                <strong className="drawing-properties-title">
                  Shape properties
                </strong>
                <DrawingStyleControls
                  kind={primaryObject.kind}
                  style={selectedDrawingStyle}
                  palette={palette}
                  onPaletteChange={(next) => onDrawingPaletteChange?.(next)}
                  onPreview={previewSelectedShapeStyle}
                  onCommit={commitSelectedShapeStyle}
                />
              </div>
            ) : null}
          </SelectionActions>
        ) : null}
      </div>

      <CanvasToolbar
        tool={tool}
        zoom={zoom}
        canUndo={history.undo.length > 0}
        canRedo={history.redo.length > 0}
        canPaste={hasClipboard}
        onToolChange={changeTool}
        onUndo={undo}
        onRedo={redo}
        onPaste={pasteClipboard}
      />
      {placementTool !== null && placementPropertiesOpen ? (
        placementTool === "highlighter" ? (
          <DrawingPlacementPanel
            tool="highlighter"
            style={{
              ...drawingStyle,
              strokeColor: highlighterStyle.color,
              strokeWidth: highlighterStyle.width,
            }}
            palette={highlighterStyle.palette}
            onPaletteChange={(next) =>
              setHighlighterStyle((current) => ({ ...current, palette: next }))
            }
            onPreview={(patch) =>
              setHighlighterStyle((current) => ({
                ...current,
                ...(patch.strokeColor !== undefined
                  ? { color: patch.strokeColor }
                  : {}),
                ...(patch.strokeWidth !== undefined
                  ? { width: patch.strokeWidth }
                  : {}),
              }))
            }
            onCommit={() => undefined}
          />
        ) : (
          <DrawingPlacementPanel
            tool={placementTool}
            style={drawingStyle}
            palette={palette}
            onPaletteChange={(next) => onDrawingPaletteChange?.(next)}
            onPreview={(patch) =>
              setDrawingStyle((current) => ({ ...current, ...patch }))
            }
            onCommit={() => undefined}
          />
        )
      ) : null}
      {scrollBounds ? (
        <CanvasScrollbars
          bounds={scrollBounds}
          viewport={viewport}
          visibleWidth={view.width}
          visibleHeight={view.height}
          canLockX={canLockX}
          canLockY={canLockY}
          lockedX={axisLocks.x}
          lockedY={axisLocks.y}
          onToggleLock={(axis) =>
            setAxisLocks((current) => ({
              ...current,
              [axis]: !current[axis],
            }))
          }
          onViewportChange={setViewport}
        />
      ) : null}
    </div>
  );
}
