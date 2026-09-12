// React hook owning viewport state: non-passive wheel zoom/pan, programmatic pan/zoom, container size tracking. Presentation transforms only; never touches persisted objects.
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Viewport } from "@aurora/shared";
import type { Point } from "./viewport";
import {
  clampZoom,
  decayMomentum,
  panViewport,
  visibleCanvasBounds,
  zoomViewportAround,
} from "./viewport";

export interface ContainerSize {
  width: number;
  height: number;
}

export interface UseViewportResult {
  viewport: Viewport;
  setViewport: Dispatch<SetStateAction<Viewport>>;
  containerRef: RefObject<HTMLDivElement | null>;
  containerSize: ContainerSize;
  containerSizeRef: RefObject<ContainerSize | null>;
  panBy: (dxScreen: number, dyScreen: number) => void;
  /** Continues a released one-finger pan with frame-rate-independent decay. */
  startMomentum: (velocityScreen: Point) => void;
  /** Cancels active touch momentum before a new gesture. */
  stopMomentum: () => void;
  zoomAt: (anchorScreen: Point, nextZoom: number) => void;
  /** Converts a container-relative screen point into canvas coordinates. */
  toCanvas: (p: Point) => Point;
}

const EMPTY_SIZE: ContainerSize = { width: 0, height: 0 };

export function useViewport(
  initial: Viewport,
  panLocks: { x: boolean; y: boolean } = { x: false, y: false },
): UseViewportResult {
  const [viewport, setViewport] = useState<Viewport>(initial);
  const [containerSize, setContainerSize] = useState<ContainerSize>(EMPTY_SIZE);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const containerSizeRef = useRef<ContainerSize | null>(EMPTY_SIZE);
  const momentumFrameRef = useRef<number | null>(null);

  containerSizeRef.current = containerSize;

  const zoomAt = useCallback(
    (anchorScreen: Point, nextZoom: number) => {
      setViewport((prev) => {
        const next = zoomViewportAround(
          prev,
          anchorScreen,
          clampZoom(nextZoom),
          containerSizeRef.current ?? EMPTY_SIZE,
        );
        return {
          ...next,
          x: panLocks.x ? prev.x : next.x,
          y: panLocks.y ? prev.y : next.y,
        };
      });
    },
    [panLocks.x, panLocks.y],
  );

  const panBy = useCallback(
    (dxScreen: number, dyScreen: number) => {
      setViewport((prev) =>
        panViewport(prev, panLocks.x ? 0 : dxScreen, panLocks.y ? 0 : dyScreen),
      );
    },
    [panLocks.x, panLocks.y],
  );

  const stopMomentum = useCallback((): void => {
    if (momentumFrameRef.current !== null) {
      cancelAnimationFrame(momentumFrameRef.current);
      momentumFrameRef.current = null;
    }
  }, []);

  const startMomentum = useCallback(
    (velocityScreen: Point): void => {
      stopMomentum();
      let velocity = velocityScreen;
      let previous = performance.now();
      const step = (now: number): void => {
        const elapsed = Math.min(32, now - previous);
        previous = now;
        panBy(velocity.x * elapsed, velocity.y * elapsed);
        velocity = decayMomentum(velocity, elapsed);
        if (Math.hypot(velocity.x, velocity.y) < 0.02) {
          momentumFrameRef.current = null;
          return;
        }
        momentumFrameRef.current = requestAnimationFrame(step);
      };
      if (Math.hypot(velocity.x, velocity.y) >= 0.02) {
        momentumFrameRef.current = requestAnimationFrame(step);
      }
    },
    [panBy, stopMomentum],
  );

  useEffect(() => stopMomentum, [stopMomentum]);

  const toCanvas = useCallback(
    (p: Point): Point => {
      const v = viewport;
      return { x: v.x + p.x / v.zoom, y: v.y + p.y / v.zoom };
    },
    [viewport],
  );

  // Native wheel listener (React attaches wheel as passive; preventDefault needs non-passive).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (
        e.target instanceof Element &&
        e.target.closest('[data-canvas-controls="true"]') !== null
      ) {
        return;
      }
      const textScroller =
        e.target instanceof Element
          ? e.target.closest<HTMLElement>(".rich-text-content")
          : null;
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        textScroller &&
        ((e.deltaY < 0 && textScroller.scrollTop > 0) ||
          (e.deltaY > 0 &&
            textScroller.scrollTop + textScroller.clientHeight <
              textScroller.scrollHeight))
      )
        return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const anchor: Point = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        };
        zoomAt(anchor, viewport.zoom * Math.exp(-e.deltaY * 0.0015));
      } else {
        panBy(-e.deltaX, -e.deltaY);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [containerRef, viewport.zoom, zoomAt, panBy]);

  // Container size tracking for culling and transforms.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = (): void => {
      const size = { width: el.clientWidth, height: el.clientHeight };
      containerSizeRef.current = size;
      setContainerSize(size);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [containerRef]);

  return {
    viewport,
    setViewport,
    containerRef,
    containerSize,
    containerSizeRef,
    panBy,
    startMomentum,
    stopMomentum,
    zoomAt,
    toCanvas,
  };
}

/** Initial viewport for a container of unknown size; bounds fill in from size tracking. */
export function makeInitialViewport(zoom: number): Viewport {
  const bounds = visibleCanvasBounds(EMPTY_SIZE, {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    zoom,
  });
  return { ...bounds, zoom };
}
