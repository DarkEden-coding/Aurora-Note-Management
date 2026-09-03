// Pressure-aware pen capture with palm rejection: records coalesced Pointer Events into stroke points. Touch pointers are ignored while pen priority is held; pen input always wins over touch, and priority decays shortly after the last pen event so touch navigation can resume.
import { useCallback, useEffect, useRef, useState } from "react";
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
  /** True while pen priority is held (a pen stroke is in progress or was interrupted). */
  penPriority: boolean;
  handlers: PenCaptureHandlers;
}

const MOUSE_FALLBACK_PRESSURE = 0.5;
/** Grace period after the last pen event during which touch stays rejected (resting palm). */
const PEN_PRIORITY_DECAY_MS = 1000;

export function usePenCapture(options: PenCaptureOptions): UsePenCaptureResult {
  const { isActive, toCanvas, onStrokeComplete } = options;
  const activePointerId = useRef<number | null>(null);
  const penPriorityRef = useRef(false);
  const penPriorityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointsRef = useRef<StrokePoint[]>([]);
  const [preview, setPreview] = useState<StrokePoint[] | null>(null);
  const [penPriority, setPenPriority] = useState(false);

  const holdPenPriority = useCallback((): void => {
    penPriorityRef.current = true;
    setPenPriority(true);
    if (penPriorityTimer.current !== null)
      clearTimeout(penPriorityTimer.current);
    penPriorityTimer.current = setTimeout(() => {
      penPriorityRef.current = false;
      setPenPriority(false);
    }, PEN_PRIORITY_DECAY_MS);
  }, []);

  useEffect(
    () => () => {
      if (penPriorityTimer.current !== null)
        clearTimeout(penPriorityTimer.current);
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!isActive) return;
      // Palm rejection: a pen always starts a stroke; touch never does while pen priority is held.
      if (
        e.pointerType === "touch" &&
        (penPriorityRef.current ||
          activePointerId.current !== null ||
          !e.isPrimary)
      )
        return;
      if (activePointerId.current !== null) return;
      if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
      if (e.pointerType === "mouse" && e.button !== 0) return;

      activePointerId.current = e.pointerId;
      if (e.pointerType === "pen") holdPenPriority();
      const rect = e.currentTarget.getBoundingClientRect();
      const pressure = pressureFromEvent(e.nativeEvent);
      pointsRef.current = [
        {
          x: toCanvasX(e.nativeEvent.clientX, rect),
          y: toCanvasY(e.nativeEvent.clientY, rect),
          pressure,
        },
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
      for (const event of list) {
        pointsRef.current = [
          ...pointsRef.current,
          {
            x: toCanvasX(event.clientX, rect),
            y: toCanvasY(event.clientY, rect),
            pressure: pressureFromEvent(event),
          },
        ];
      }
      if (native.pointerType === "pen") holdPenPriority();
      setPreview([...pointsRef.current]);
    },
    [toCanvas],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (activePointerId.current !== e.pointerId) return;
      activePointerId.current = null;
      const points = pointsRef.current;
      pointsRef.current = [];
      setPreview(null);
      if (points.length > 1) onStrokeComplete(points);
    },
    [onStrokeComplete],
  );

  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (activePointerId.current !== e.pointerId) return;
    activePointerId.current = null;
    pointsRef.current = [];
    setPreview(null);
  }, []);

  return {
    preview,
    penPriority,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}

function toCanvasX(clientX: number, rect: DOMRect): number {
  return clientX - rect.left;
}

function toCanvasY(clientY: number, rect: DOMRect): number {
  return clientY - rect.top;
}

function pressureFromEvent(e: {
  pointerType: string;
  pressure: number;
}): number {
  if (e.pointerType === "pen" && e.pressure > 0) return e.pressure;
  return MOUSE_FALLBACK_PRESSURE;
}
