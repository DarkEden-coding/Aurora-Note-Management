// Pressure-aware pen capture: records coalesced Pointer Events into canvas-space stroke points while touch remains available for navigation.
import { useCallback, useRef, useState } from "react";
import type React from "react";
import type { Point } from "./viewport";
import type { StrokePoint } from "./objects";

export interface PenCaptureOptions {
  /** Whether the pen tool is currently active; capture runs only while true. */
  isActive: boolean;
  toCanvas: (p: Point) => Point;
  onStrokeComplete: (points: StrokePoint[]) => void;
}

export interface PenCaptureHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
}

export interface UsePenCaptureResult {
  /** Live preview points while a stroke is in progress; `null` otherwise. */
  preview: StrokePoint[] | null;
  /** Reports synchronously whether a pen or mouse stroke is in progress. */
  isDrawing: () => boolean;
  handlers: PenCaptureHandlers;
}

const MOUSE_FALLBACK_PRESSURE = 0.5;

export function usePenCapture(options: PenCaptureOptions): UsePenCaptureResult {
  const { isActive, toCanvas, onStrokeComplete } = options;
  const activePointerId = useRef<number | null>(null);
  const pointsRef = useRef<StrokePoint[]>([]);
  const [preview, setPreview] = useState<StrokePoint[] | null>(null);
  const isDrawing = useCallback(
    (): boolean => activePointerId.current !== null,
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!isActive) return;
      if (activePointerId.current !== null) return;
      if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
      if (e.pointerType === "mouse" && e.button !== 0) return;

      activePointerId.current = e.pointerId;
      const rect = e.currentTarget.getBoundingClientRect();
      const point = toCanvas({
        x: e.nativeEvent.clientX - rect.left,
        y: e.nativeEvent.clientY - rect.top,
      });
      pointsRef.current = [
        { ...point, pressure: pressureFromEvent(e.nativeEvent) },
      ];
      setPreview([...pointsRef.current]);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture is best-effort.
      }
    },
    [isActive, toCanvas],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (activePointerId.current !== e.pointerId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const native = e.nativeEvent;
      const events =
        typeof native.getCoalescedEvents === "function"
          ? native.getCoalescedEvents()
          : [];
      const list = events.length > 0 ? events : [native];
      appendPointerSamples(list, rect, toCanvas, pointsRef.current);
      setPreview([...pointsRef.current]);
    },
    [toCanvas],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (activePointerId.current !== e.pointerId) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const native = e.nativeEvent;
      const events =
        typeof native.getCoalescedEvents === "function"
          ? native.getCoalescedEvents()
          : [];
      appendPointerSamples(
        events.length > 0 ? events : [native],
        rect,
        toCanvas,
        pointsRef.current,
      );
      activePointerId.current = null;
      const points = pointsRef.current;
      pointsRef.current = [];
      setPreview(null);
      if (points.length > 1) onStrokeComplete(points);
    },
    [onStrokeComplete, toCanvas],
  );

  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (activePointerId.current !== e.pointerId) return;
    activePointerId.current = null;
    pointsRef.current = [];
    setPreview(null);
  }, []);

  return {
    preview,
    isDrawing,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}

/** Appends browser pointer samples after converting viewport coordinates into canvas coordinates. */
function appendPointerSamples(
  events: PointerEvent[],
  rect: DOMRect,
  toCanvas: (point: Point) => Point,
  points: StrokePoint[],
): void {
  for (const event of events) {
    const point = toCanvas({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    points.push({ ...point, pressure: pressureFromEvent(event) });
  }
}

/** Uses real pen pressure and a stable midpoint for mouse drawing. */
function pressureFromEvent(e: {
  pointerType: string;
  pressure: number;
}): number {
  if (e.pointerType === "pen" && e.pressure > 0) return e.pressure;
  return MOUSE_FALLBACK_PRESSURE;
}
