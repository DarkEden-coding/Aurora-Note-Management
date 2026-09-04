// Canvas workspace composition: four canvas modes, viewport transform with overscan culling, backgrounds, selection/move/resize gestures, pen capture with palm rejection, mouse/touch navigation, paged page frames, and object creation. Edits emit coalesced SyncOperations through onOperation; object rendering is delegated to ObjectRenderer, and the sync cache supplies objects when the prop is omitted.
import type React from "react";
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
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
  type SyncOperation,
} from "@aurora/shared";
import { db } from "../../sync/db";
import { syncEngine } from "../../sync/engine";
import { CanvasToolbar, type CanvasTool } from "./CanvasToolbar";
import {
  HtmlObject,
  PressureStrokePath,
  SceneObject,
  type HtmlObjectCallbacks,
} from "./ObjectRenderer";
import { DEFAULT_BACKGROUND, getBackgroundStyle } from "./backgrounds";
import { DEFAULT_OVERSCAN, queryVisibleObjects, sortByZIndex } from "./culling";
import { buildDemoObjects } from "./DemoContent";
import {
  applyResize,
  dragBoundsAxis,
  dragBoundsFree,
  handleAtPoint,
  handlePositions,
  hitTestTopmost,
  makeCanvasObject,
  nextZIndex,
  pointsToBounds,
  setStrokePayload,
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
  MAX_OBJECTS_PER_NOTE,
  type CanvasScrollBounds,
  canvasScrollBounds,
  canvasSurfaceFrames,
  clampBoundsToMode,
  translateBoundsInMode,
} from "./pageLayout";
import { usePenCapture } from "./usePenCapture";
import { useSelection } from "./useSelection";
import { useViewport } from "./useViewport";
import { screenToCanvas, type Point } from "./viewport";

export interface CanvasWorkspaceProps {
  /** Authenticated owner for newly created persisted objects; omit only in demos. */
  ownerId?: string;
  noteId: string;
  /** Canvas mode; defaults to "infinite". */
  mode?: CanvasMode;
  background?: Background;
  /** Canonical objects; when omitted, the workspace loads from the local sync cache and falls back to demo content. */
  objects?: CanvasObject[];
  /** Receives every coalesced upsert/delete operation produced by editing gestures. */
  onOperation?: (operation: SyncOperation) => void;
}

const STROKE_TOOL_COLOR = "#78a0ff";
const STROKE_TOOL_WIDTH = 2.5;
const DEFAULT_STICKY_WIDTH = 190;
const DEFAULT_STICKY_HEIGHT = 190;
const STICKY_COLOR = "#f7d774";
const SHAPE_COLOR = "#e6e8ec";
const HANDLE_SCREEN_SIZE = 9;
const HANDLE_HIT_TOLERANCE_SCREEN = 12;

/** One active pointer gesture at a time. */
type Gesture =
  | { kind: "pan"; lastScreen: Point }
  | { kind: "move"; ids: string[]; start: Point; origins: Map<string, Bounds> }
  | {
      kind: "resize";
      id: string;
      handle: Handle;
      start: Point;
      startBounds: Bounds;
    }
  | { kind: "create"; tool: CreateTool; start: Point; current: Point };

type CreateTool =
  "line" | "rectangle" | "ellipse" | "arrow" | "sticky" | "text";

const CREATE_TOOLS: readonly string[] = [
  "line",
  "rectangle",
  "ellipse",
  "arrow",
  "sticky",
  "text",
];

function isCreateTool(tool: CanvasTool): tool is CreateTool {
  return CREATE_TOOLS.includes(tool);
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
  onOperation,
}: CanvasWorkspaceProps): ReactNode {
  const activeMode: CanvasMode = mode ?? "infinite";
  const isControlled = objects !== undefined;

  const {
    viewport,
    setViewport,
    containerRef,
    containerSize,
    panBy,
    zoomAt,
    toCanvas,
  } = useViewport({
    x: -64,
    y: -96,
    width: 0,
    height: 0,
    zoom: 1,
  });

  const [mirror, setMirror] = useState<CanvasObject[]>(() => objects ?? []);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const selection = useSelection();
  const deviceIdRef = useRef(getDeviceId());
  const pinchRef = useRef<Map<number, Point>>(new Map());
  const pinchSpanRef = useRef<{ distance: number; mid: Point } | null>(null);

  // Controlled mode: the parent's array is the source of truth.
  useEffect(() => {
    if (isControlled) setMirror(objects);
  }, [isControlled, objects]);

  const demoObjects = useMemo(
    () => (idSchema.safeParse(noteId).success ? [] : buildDemoObjects(noteId)),
    [noteId],
  );

  // Reset the working set when the note changes.
  useEffect(() => {
    setMirror(isControlled ? (objects ?? []) : []);
    selection.clear();
    setGesture(null);
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
            (activeGesture.kind === "resize" && activeGesture.id === objectId));

        for (const objectId of event.deletedObjectIds) {
          if (byId.has(objectId) && !gestureTouches(objectId)) {
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
            byId.set(remote.id, remote);
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
      onOperationRef.current?.(
        makeUpsertOperation(object, noteId, deviceIdRef.current),
      );
    },
    [noteId],
  );

  const appendObject = useCallback(
    (object: CanvasObject): void => {
      setMirror((prev) => [...prev, object]);
      commitUpsert(object);
    },
    [commitUpsert],
  );

  const createObject = useCallback(
    (createTool: CreateTool, raw: Bounds): void => {
      if (objectsRef.current.length >= MAX_OBJECTS_PER_NOTE) return;
      const bounds = clampBoundsToMode(raw, activeMode);
      const kind =
        createTool === "sticky"
          ? ("sticky-note" as const)
          : createTool === "text"
            ? ("rich-text" as const)
            : createTool === "rectangle"
              ? ("rectangle" as const)
              : createTool === "ellipse"
                ? ("ellipse" as const)
                : createTool === "arrow"
                  ? ("arrow" as const)
                  : ("line" as const);
      const shapePayload: CanvasObject["payload"] =
        kind === "rectangle" || kind === "ellipse"
          ? {
              color: SHAPE_COLOR,
              fill: "rgba(120, 160, 255, 0.12)",
              strokeWidth: 2,
            }
          : { color: SHAPE_COLOR, strokeWidth: 2 };
      const object = makeCanvasObject({
        id: newId(),
        ownerId: ownerId ?? objectsRef.current[0]?.ownerId ?? DEMO_OWNER_ID,
        noteId,
        kind,
        bounds,
        zIndex: nextZIndex(objectsRef.current),
        payload:
          createTool === "sticky"
            ? { text: "", color: STICKY_COLOR }
            : createTool === "text"
              ? { doc: { type: "doc", content: [{ type: "paragraph" }] } }
              : shapePayload,
      });
      appendObject(object);
      selection.select(object.id);
    },
    // selection.select is stable; selection excluded to avoid gesture churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeMode, ownerId, noteId, appendObject],
  );

  const deleteSelection = useCallback((): void => {
    const ids = [...selection.selectedIds];
    if (ids.length === 0) return;
    const removed: CanvasObject[] = [];
    setMirror((prev) =>
      prev.filter((o) => {
        if (!ids.includes(o.id) || o.locked) return true;
        removed.push(o);
        return false;
      }),
    );
    for (const o of removed) {
      onOperationRef.current?.(
        makeDeleteOperation(o.id, o.revision, noteId, deviceIdRef.current),
      );
    }
    selection.clear();
  }, [noteId, selection]);

  // Keyboard: tool shortcuts, selection delete, and escape.
  useEffect(() => {
    const shortcuts: Record<string, CanvasTool> = {
      v: "select",
      h: "pan",
      p: "pen",
      t: "text",
      l: "line",
      r: "rectangle",
      e: "ellipse",
      a: "arrow",
      s: "sticky",
    };
    const onKeyDown = (e: KeyboardEvent): void => {
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
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (e.key === "Escape") {
        selection.clear();
        return;
      }
      const next = shortcuts[e.key.toLowerCase()];
      if (next) setTool(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelection, selection]);

  const pen = usePenCapture({
    isActive: tool === "pen",
    toCanvas,
    onStrokeComplete: (points) => {
      if (
        points.length < 2 ||
        objectsRef.current.length >= MAX_OBJECTS_PER_NOTE
      )
        return;
      const bounds = clampBoundsToMode(
        pointsToBounds(points, STROKE_TOOL_WIDTH * 2),
        activeMode,
      );
      const object = makeCanvasObject({
        id: newId(),
        ownerId: ownerId ?? objectsRef.current[0]?.ownerId ?? DEMO_OWNER_ID,
        noteId,
        kind: "stroke",
        bounds,
        zIndex: nextZIndex(objectsRef.current),
        payload: setStrokePayload(points, STROKE_TOOL_COLOR, STROKE_TOOL_WIDTH),
      });
      appendObject(object);
      selection.select(object.id);
    },
  });

  // Touch pans/pinches unless the pen is active (palm rejection).
  const touchNavigationAllowed =
    tool === "pan" || tool === "select" || (tool === "pen" && !pen.penPriority);
  const touchNavigationRef = useRef(touchNavigationAllowed);
  touchNavigationRef.current = touchNavigationAllowed;

  // ---- Pointer gestures ----------------------------------------------------

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      const screen: Point = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      if (e.pointerType === "touch") {
        pinchRef.current.set(e.pointerId, screen);
        if (pinchRef.current.size === 2) {
          const [a, b] = [...pinchRef.current.values()];
          if (a === undefined || b === undefined) return;
          pinchSpanRef.current = {
            distance: Math.hypot(b.x - a.x, b.y - a.y),
            mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          };
          setGesture(null);
        } else if (pinchRef.current.size === 1 && touchNavigationRef.current) {
          setGesture({ kind: "pan", lastScreen: screen });
        }
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Pointer capture is best-effort.
        }
        return;
      }

      if (tool === "pan" || (e.pointerType === "mouse" && e.button === 1)) {
        setGesture({ kind: "pan", lastScreen: screen });
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Pointer capture is best-effort.
        }
        return;
      }

      if (isInsideEditable(e.target)) return;

      const canvasPoint = screenToCanvas(screen, viewportRef.current);

      if (tool === "select") {
        const primary =
          objectsRef.current.find((o) => o.id === primaryId) ?? null;
        if (primary !== null && !primary.locked) {
          const handle = handleAtPoint(
            primary.bounds,
            canvasPoint,
            HANDLE_HIT_TOLERANCE_SCREEN / viewportRef.current.zoom,
          );
          if (handle !== null) {
            setGesture({
              kind: "resize",
              id: primary.id,
              handle,
              start: canvasPoint,
              startBounds: primary.bounds,
            });
            try {
              el.setPointerCapture(e.pointerId);
            } catch {
              // Pointer capture is best-effort.
            }
            return;
          }
        }
        const hit = hitTestTopmost(
          objectsRef.current.filter((o) => !o.locked),
          canvasPoint,
        );
        if (hit === null) {
          selection.select(null, e.shiftKey);
          return;
        }
        selection.select(hit.id, e.shiftKey);
        // Compute the move set from the pre-toggle selection plus the hit.
        const previous = e.shiftKey ? [...selection.selectedIds] : [];
        const moveIds = previous.includes(hit.id)
          ? previous.filter((id) => id !== hit.id)
          : [...previous, hit.id];
        const origins = new Map<string, Bounds>();
        for (const id of moveIds) {
          const o = objectsRef.current.find((c) => c.id === id);
          if (o !== undefined && !o.locked) origins.set(id, o.bounds);
        }
        if (origins.size > 0) {
          setGesture({
            kind: "move",
            ids: [...origins.keys()],
            start: canvasPoint,
            origins,
          });
        }
        return;
      }

      if (tool === "sticky") {
        createObject("sticky", {
          x: canvasPoint.x,
          y: canvasPoint.y,
          width: DEFAULT_STICKY_WIDTH,
          height: DEFAULT_STICKY_HEIGHT,
        });
        return;
      }

      if (isCreateTool(tool)) {
        setGesture({
          kind: "create",
          tool,
          start: canvasPoint,
          current: canvasPoint,
        });
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // Pointer capture is best-effort.
        }
      }
    },
    // selection methods are stable; selection excluded to avoid gesture churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tool, primaryId, createObject],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const rect = el.getBoundingClientRect();
      const screen: Point = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      if (e.pointerType === "touch" && pinchRef.current.has(e.pointerId)) {
        pinchRef.current.set(e.pointerId, screen);
        if (pinchRef.current.size === 2 && pinchSpanRef.current !== null) {
          const [a, b] = [...pinchRef.current.values()];
          if (a === undefined || b === undefined) return;
          const distance = Math.hypot(b.x - a.x, b.y - a.y);
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const prev = pinchSpanRef.current;
          if (distance > 0 && prev.distance > 0) {
            zoomAt(mid, viewportRef.current.zoom * (distance / prev.distance));
          }
          panBy(mid.x - prev.mid.x, mid.y - prev.mid.y);
          pinchSpanRef.current = { distance, mid };
        } else {
          pinchSpanRef.current = null;
        }
        return;
      }

      const current = gestureRef.current;
      if (current === null) return;

      if (current.kind === "pan") {
        panBy(screen.x - current.lastScreen.x, screen.y - current.lastScreen.y);
        setGesture({ kind: "pan", lastScreen: screen });
        return;
      }

      const canvasPoint = screenToCanvas(screen, viewportRef.current);
      if (current.kind === "move") {
        const dx = canvasPoint.x - current.start.x;
        const dy = canvasPoint.y - current.start.y;
        setMirror((prev) =>
          prev.map((o) => {
            const origin = current.origins.get(o.id);
            if (origin === undefined) return o;
            return {
              ...o,
              bounds: translateBoundsInMode(origin, dx, dy, activeMode),
            };
          }),
        );
        return;
      }
      if (current.kind === "resize") {
        const next = clampBoundsToMode(
          applyResize(
            current.startBounds,
            current.handle,
            current.start,
            canvasPoint,
          ),
          activeMode,
        );
        setMirror((prev) =>
          prev.map((o) => (o.id === current.id ? { ...o, bounds: next } : o)),
        );
        return;
      }
      setGesture({ ...current, current: canvasPoint });
    },
    [activeMode, panBy, zoomAt],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "touch") {
        pinchRef.current.delete(e.pointerId);
        if (pinchRef.current.size < 2) pinchSpanRef.current = null;
      }
      const current = gestureRef.current;
      setGesture(null);
      if (current === null) return;

      if (current.kind === "move") {
        // One coalesced upsert per moved object.
        for (const o of objectsRef.current) {
          const origin = current.origins.get(o.id);
          if (origin === undefined) continue;
          if (o.bounds.x === origin.x && o.bounds.y === origin.y) continue;
          commitUpsert({ ...o, updatedAt: new Date().toISOString() });
        }
        return;
      }
      if (current.kind === "resize") {
        const o = objectsRef.current.find((c) => c.id === current.id);
        if (o !== undefined)
          commitUpsert({ ...o, updatedAt: new Date().toISOString() });
        return;
      }
      if (current.kind === "create") {
        const raw =
          current.tool === "line" || current.tool === "arrow"
            ? dragBoundsAxis(current.start, current.current)
            : dragBoundsFree(current.start, current.current);
        if (raw.width >= 2 || raw.height >= 2) createObject(current.tool, raw);
      }
    },
    [commitUpsert, createObject],
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "touch") {
        pinchRef.current.delete(e.pointerId);
        if (pinchRef.current.size < 2) pinchSpanRef.current = null;
      }
      const current = gestureRef.current;
      if (current?.kind === "move") {
        // Roll back to gesture-start positions; nothing was committed.
        setMirror((prev) =>
          prev.map((o) => {
            const origin = current.origins.get(o.id);
            return origin === undefined ? o : { ...o, bounds: origin };
          }),
        );
      } else if (current?.kind === "resize") {
        setMirror((prev) =>
          prev.map((o) =>
            o.id === current.id ? { ...o, bounds: current.startBounds } : o,
          ),
        );
      }
      setGesture(null);
    },
    [],
  );

  const updateObjectWithPayload = useCallback(
    (o: CanvasObject, payloadPatch: Record<string, unknown>): void => {
      const next = {
        ...o,
        payload: { ...o.payload, ...payloadPatch },
        updatedAt: new Date().toISOString(),
      };
      setMirror((prev) => prev.map((c) => (c.id === next.id ? next : c)));
      commitUpsert(next);
    },
    [commitUpsert],
  );

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
      canvasScrollBounds(displayObjects, activeMode, view.width, view.height),
    [displayObjects, activeMode, view.width, view.height],
  );
  const centeredModeRef = useRef("");

  useEffect(() => {
    if (scrollBounds === null) return;
    const identity = `${noteId}:${activeMode}`;
    const shouldCenter = centeredModeRef.current !== identity;
    if (shouldCenter) centeredModeRef.current = identity;
    setViewport((current) => {
      const nextX = shouldCenter
        ? (scrollBounds.contentWidth - view.width) / 2
        : Math.max(scrollBounds.minX, Math.min(current.x, scrollBounds.maxX));
      const preferredTop = -80 / current.zoom;
      const nextY = shouldCenter
        ? Math.max(scrollBounds.minY, preferredTop)
        : Math.max(scrollBounds.minY, Math.min(current.y, scrollBounds.maxY));
      return nextX === current.x && nextY === current.y
        ? current
        : { ...current, x: nextX, y: nextY };
    });
  }, [activeMode, noteId, scrollBounds, setViewport, view.width]);
  const visible = sortByZIndex(
    queryVisibleObjects(displayObjects, view, DEFAULT_OVERSCAN),
  );
  const surfaceFrames = canvasSurfaceFrames(displayObjects, activeMode);
  const pageBackgroundStyle = getBackgroundStyle(
    background ?? DEFAULT_BACKGROUND,
    { x: 0, y: 0, width: 0, height: 0, zoom: 1 },
  );

  const cursor =
    gesture?.kind === "pan"
      ? "panning"
      : tool === "pan"
        ? "pan"
        : tool === "pen"
          ? "pen"
          : tool === "select"
            ? "default"
            : "create";

  // In-progress creation preview.
  let previewShape: CanvasObject | null = null;
  let previewStickyBounds: Bounds | null = null;
  if (gesture?.kind === "create") {
    const raw =
      gesture.tool === "line" || gesture.tool === "arrow"
        ? dragBoundsAxis(gesture.start, gesture.current)
        : dragBoundsFree(gesture.start, gesture.current);
    if (gesture.tool === "sticky" || gesture.tool === "text") {
      previewStickyBounds = raw;
    } else {
      previewShape = makeCanvasObject({
        id: "preview",
        ownerId: DEMO_OWNER_ID,
        noteId,
        kind: gesture.tool,
        bounds: raw,
        zIndex: 0,
        payload:
          gesture.tool === "rectangle" || gesture.tool === "ellipse"
            ? {
                color: STROKE_TOOL_COLOR,
                fill: "rgba(120, 160, 255, 0.12)",
                strokeWidth: 2,
              }
            : { color: STROKE_TOOL_COLOR, strokeWidth: 2 },
      });
    }
  }

  const zoomIn = (): void => {
    zoomAt(
      { x: containerSize.width / 2, y: containerSize.height / 2 },
      zoom * 1.25,
    );
  };
  const zoomOut = (): void => {
    zoomAt(
      { x: containerSize.width / 2, y: containerSize.height / 2 },
      zoom / 1.25,
    );
  };
  const zoomReset = (): void => {
    zoomAt({ x: containerSize.width / 2, y: containerSize.height / 2 }, 1);
  };

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
          handlePointerMove(e);
        }}
        onPointerUp={(e) => {
          pen.handlers.onPointerUp(e);
          handlePointerUp(e);
        }}
        onPointerCancel={(e) => {
          pen.handlers.onPointerCancel(e);
          handlePointerCancel(e);
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
                o.kind === "arrow" ? (
                  <SceneObject key={o.id} object={o} />
                ) : null,
              )}
              {pen.preview !== null ? (
                <PressureStrokePath
                  points={pen.preview}
                  color={STROKE_TOOL_COLOR}
                  baseWidth={STROKE_TOOL_WIDTH}
                />
              ) : null}
              {previewShape !== null ? (
                <SceneObject object={previewShape} />
              ) : null}
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
                  />
                );
              })}
              {primaryObject !== null &&
              !primaryObject.locked &&
              tool === "select"
                ? handlePositions(primaryObject.bounds).map(
                    ({ handle, point }) => (
                      <rect
                        key={handle}
                        data-handle={handle}
                        className="canvas-selection-handle"
                        x={point.x - HANDLE_SCREEN_SIZE / 2 / zoom}
                        y={point.y - HANDLE_SCREEN_SIZE / 2 / zoom}
                        width={HANDLE_SCREEN_SIZE / zoom}
                        height={HANDLE_SCREEN_SIZE / zoom}
                      />
                    ),
                  )
                : null}
            </svg>
          ) : null}

          {previewStickyBounds !== null ? (
            <div
              className="canvas-create-preview"
              style={{
                left: previewStickyBounds.x,
                top: previewStickyBounds.y,
                width: previewStickyBounds.width,
                height: previewStickyBounds.height,
              }}
            />
          ) : null}

          {visible
            .filter(
              (o) =>
                o.kind !== "stroke" &&
                o.kind !== "rectangle" &&
                o.kind !== "ellipse" &&
                o.kind !== "line" &&
                o.kind !== "arrow",
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
        </div>
      </div>

      <CanvasToolbar
        tool={tool}
        mode={activeMode}
        zoom={zoom}
        objectCount={displayObjects.length}
        maxObjectCount={MAX_OBJECTS_PER_NOTE}
        onToolChange={setTool}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomReset={zoomReset}
      />
      {scrollBounds ? (
        <CanvasScrollbars
          bounds={scrollBounds}
          viewport={viewport}
          visibleWidth={view.width}
          visibleHeight={view.height}
          onViewportChange={setViewport}
        />
      ) : null}
    </div>
  );
}

function CanvasScrollbars({
  bounds,
  viewport,
  visibleWidth,
  visibleHeight,
  onViewportChange,
}: {
  bounds: CanvasScrollBounds;
  viewport: { x: number; y: number; zoom: number };
  visibleWidth: number;
  visibleHeight: number;
  onViewportChange: Dispatch<
    SetStateAction<{
      x: number;
      y: number;
      width: number;
      height: number;
      zoom: number;
    }>
  >;
}) {
  const ratioX = Math.max(
    0.08,
    Math.min(0.9, visibleWidth / (bounds.contentWidth + visibleWidth)),
  );
  const ratioY = Math.max(
    0.08,
    Math.min(0.9, visibleHeight / (bounds.contentHeight + visibleHeight)),
  );
  const progressX = Math.max(
    0,
    Math.min(1, (viewport.x - bounds.minX) / bounds.contentWidth),
  );
  const progressY = Math.max(
    0,
    Math.min(1, (viewport.y - bounds.minY) / bounds.contentHeight),
  );

  const move = (
    event: React.PointerEvent<HTMLDivElement>,
    axis: "x" | "y",
    ratio: number,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const trackSize = axis === "x" ? rect.width : rect.height;
    const pointer =
      axis === "x" ? event.clientX - rect.left : event.clientY - rect.top;
    const progress = Math.max(
      0,
      Math.min(1, (pointer / trackSize - ratio / 2) / (1 - ratio)),
    );
    onViewportChange((current) => ({
      ...current,
      [axis]:
        axis === "x"
          ? bounds.minX + progress * bounds.contentWidth
          : bounds.minY + progress * bounds.contentHeight,
    }));
  };
  const pointerDown = (
    event: React.PointerEvent<HTMLDivElement>,
    axis: "x" | "y",
    ratio: number,
  ) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    move(event, axis, ratio);
  };
  const pointerMove = (
    event: React.PointerEvent<HTMLDivElement>,
    axis: "x" | "y",
    ratio: number,
  ) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.stopPropagation();
    move(event, axis, ratio);
  };

  return (
    <div className="canvas-scrollbars" aria-label="Canvas scroll controls">
      <div
        className="canvas-scrollbar horizontal"
        role="scrollbar"
        aria-label="Horizontal canvas position"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progressX * 100)}
        onPointerDown={(event) => pointerDown(event, "x", ratioX)}
        onPointerMove={(event) => pointerMove(event, "x", ratioX)}
      >
        <span
          className="canvas-scrollbar-thumb"
          style={{
            width: `${ratioX * 100}%`,
            left: `${progressX * (1 - ratioX) * 100}%`,
          }}
        />
      </div>
      <div
        className="canvas-scrollbar vertical"
        role="scrollbar"
        aria-label="Vertical canvas position"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progressY * 100)}
        onPointerDown={(event) => pointerDown(event, "y", ratioY)}
        onPointerMove={(event) => pointerMove(event, "y", ratioY)}
      >
        <span
          className="canvas-scrollbar-thumb"
          style={{
            height: `${ratioY * 100}%`,
            top: `${progressY * (1 - ratioY) * 100}%`,
          }}
        />
      </div>
    </div>
  );
}
