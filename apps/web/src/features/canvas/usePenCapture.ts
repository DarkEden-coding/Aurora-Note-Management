// Collect pressure samples without React renders; paint new ink directly into a dedicated canvas.
import { useCallback, useEffect, useRef } from "react";
import type React from "react";
import type { Point } from "./viewport";
import type { StrokePoint } from "./objects";
import { InkPreview } from "./inkPreview";

export interface PenCaptureOptions {
  isActive: boolean;
  /** Cancels in-progress ink when switching notes. */
  noteId: string;
  toCanvas: (p: Point) => Point;
  zoom: number;
  color: string;
  baseWidth: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onStrokeComplete: (points: StrokePoint[]) => void;
}

export interface PenCaptureHandlers {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
}

export interface UsePenCaptureResult {
  previewRef: React.RefObject<HTMLCanvasElement | null>;
  isDrawing: () => boolean;
  handlers: PenCaptureHandlers;
}

export function usePenCapture(options: PenCaptureOptions): UsePenCaptureResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const previewRef = useRef<HTMLCanvasElement>(null);
  const ink = useRef(new InkPreview());
  const active = useRef<{
    id: number;
    rect: DOMRect;
    toCanvas: (p: Point) => Point;
    points: StrokePoint[];
    lastTime: number;
    lastX: number;
    lastY: number;
    lastPressure: number;
  } | null>(null);
  const clearFrame = useRef(0);
  const isDrawing = useCallback(() => active.current !== null, []);

  const append = useCallback((native: PointerEvent) => {
    const stroke = active.current;
    if (!stroke || native.pointerId !== stroke.id) return;
    const coalesced = native.getCoalescedEvents?.() ?? [];
    // Include the dispatched event too: some browsers omit its final position.
    const samples = coalesced.length ? [...coalesced, native] : [native];
    for (const event of samples) {
      const pressure =
        event.pointerType === "pen" && event.pressure > 0
          ? event.pressure
          : 0.5;
      // rawupdate and pointermove can deliver the same samples. Preserve all new positions.
      if (
        event.timeStamp < stroke.lastTime ||
        (event.clientX === stroke.lastX &&
          event.clientY === stroke.lastY &&
          pressure === stroke.lastPressure)
      )
        continue;
      const point = {
        x: event.clientX - stroke.rect.left,
        y: event.clientY - stroke.rect.top,
      };
      stroke.points.push({ ...stroke.toCanvas(point), pressure });
      ink.current.append({ ...point, pressure });
      stroke.lastTime = event.timeStamp;
      stroke.lastX = event.clientX;
      stroke.lastY = event.clientY;
      stroke.lastPressure = pressure;
    }
  }, []);

  const cancel = useCallback(() => {
    active.current = null;
    cancelAnimationFrame(clearFrame.current);
    ink.current.clear();
  }, []);

  useEffect(() => {
    // Unsupported browsers simply never dispatch this event; pointermove remains the fallback.
    const container = options.containerRef.current;
    const onRawUpdate = (event: Event) => append(event as PointerEvent);
    container?.addEventListener("pointerrawupdate", onRawUpdate);
    return () => {
      container?.removeEventListener("pointerrawupdate", onRawUpdate);
      cancel();
    };
  }, [append, cancel, options.containerRef, options.noteId, options.isActive]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const current = optionsRef.current;
      if (!current.isActive || active.current || !previewRef.current) return;
      if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      cancelAnimationFrame(clearFrame.current);
      const rect = e.currentTarget.getBoundingClientRect();
      active.current = {
        id: e.pointerId,
        rect,
        toCanvas: current.toCanvas,
        points: [],
        lastTime: -Infinity,
        lastX: NaN,
        lastY: NaN,
        lastPressure: NaN,
      };
      ink.current.begin(
        previewRef.current,
        rect.width,
        rect.height,
        current.color,
        current.baseWidth,
        current.zoom,
        window.devicePixelRatio || 1,
      );
      append(e.nativeEvent);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* Best effort. */
      }
    },
    [append],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => append(e.nativeEvent),
    [append],
  );
  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (active.current?.id !== e.pointerId) return;
      append(e.nativeEvent);
      const points = active.current.points;
      active.current = null;
      if (points.length) optionsRef.current.onStrokeComplete(points);
      // Keep ink until React has painted the committed scene, avoiding a pen-up flash.
      clearFrame.current = requestAnimationFrame(() => {
        clearFrame.current = requestAnimationFrame(() => ink.current.clear());
      });
    },
    [append],
  );
  const onPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (active.current?.id === e.pointerId) cancel();
    },
    [cancel],
  );
  return {
    previewRef,
    isDrawing,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
