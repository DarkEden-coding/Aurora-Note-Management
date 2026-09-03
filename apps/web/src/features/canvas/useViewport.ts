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
  zoomAt: (anchorScreen: Point, nextZoom: number) => void;
  /** Converts a container-relative screen point into canvas coordinates. */
  toCanvas: (p: Point) => Point;
}

const EMPTY_SIZE: ContainerSize = { width: 0, height: 0 };

export function useViewport(initial: Viewport): UseViewportResult {
  const [viewport, setViewport] = useState<Viewport>(initial);
  const [containerSize, setContainerSize] = useState<ContainerSize>(EMPTY_SIZE);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const containerSizeRef = useRef<ContainerSize | null>(EMPTY_SIZE);

  containerSizeRef.current = containerSize;

  const zoomAt = useCallback((anchorScreen: Point, nextZoom: number) => {
    setViewport((prev) =>
      zoomViewportAround(
        prev,
        anchorScreen,
        clampZoom(nextZoom),
        containerSizeRef.current ?? EMPTY_SIZE,
      ),
    );
  }, []);

  const panBy = useCallback((dxScreen: number, dyScreen: number) => {
    setViewport((prev) => panViewport(prev, dxScreen, dyScreen));
  }, []);

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
