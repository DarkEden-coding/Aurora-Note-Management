// Custom canvas scrollbars and fixed-axis lock controls. Viewport navigation lives here so CanvasWorkspace only composes the canvas experience.
import {
  type Dispatch,
  type PointerEvent,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Viewport } from "@aurora/shared";
import { Lock, Unlock } from "lucide-react";
import type { CanvasScrollBounds } from "./pageLayout";

export interface CanvasScrollbarsProps {
  bounds: CanvasScrollBounds;
  viewport: Viewport;
  visibleWidth: number;
  visibleHeight: number;
  canLockX: boolean;
  canLockY: boolean;
  lockedX: boolean;
  lockedY: boolean;
  onToggleLock: (axis: "x" | "y") => void;
  onViewportChange: Dispatch<SetStateAction<Viewport>>;
}

/** Navigates overflowing canvas surfaces and exposes applicable axis locks. */
export function CanvasScrollbars({
  bounds,
  viewport,
  visibleWidth,
  visibleHeight,
  canLockX,
  canLockY,
  lockedX,
  lockedY,
  onToggleLock,
  onViewportChange,
}: CanvasScrollbarsProps): ReactNode {
  const overflowsX = bounds.contentWidth > visibleWidth;
  const overflowsY = bounds.contentHeight > visibleHeight;
  const ratioX = Math.max(
    0.08,
    Math.min(0.9, visibleWidth / bounds.contentWidth),
  );
  const ratioY = Math.max(
    0.08,
    Math.min(0.9, visibleHeight / bounds.contentHeight),
  );
  const rangeX = bounds.maxX - bounds.minX;
  const rangeY = bounds.maxY - bounds.minY;
  const progressX = Math.max(
    0,
    Math.min(1, (viewport.x - bounds.minX) / rangeX),
  );
  const progressY = Math.max(
    0,
    Math.min(1, (viewport.y - bounds.minY) / rangeY),
  );
  const [active, setActive] = useState({ x: true, y: true });
  const hideTimers = useRef<{ x?: number; y?: number }>({});
  const previousPosition = useRef({ x: viewport.x, y: viewport.y });

  const showAxis = useCallback((axis: "x" | "y"): void => {
    window.clearTimeout(hideTimers.current[axis]);
    setActive((current) => ({ ...current, [axis]: true }));
    hideTimers.current[axis] = window.setTimeout(
      () => setActive((current) => ({ ...current, [axis]: false })),
      1200,
    );
  }, []);

  useEffect(() => {
    if (viewport.x !== previousPosition.current.x) showAxis("x");
    if (viewport.y !== previousPosition.current.y) showAxis("y");
    previousPosition.current = { x: viewport.x, y: viewport.y };
  }, [showAxis, viewport.x, viewport.y]);

  useEffect(() => {
    showAxis("x");
    showAxis("y");
    return () => {
      window.clearTimeout(hideTimers.current.x);
      window.clearTimeout(hideTimers.current.y);
    };
  }, [showAxis]);

  const move = (
    event: PointerEvent<HTMLDivElement>,
    axis: "x" | "y",
    ratio: number,
  ): void => {
    if ((axis === "x" && lockedX) || (axis === "y" && lockedY)) return;
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
          ? bounds.minX + progress * rangeX
          : bounds.minY + progress * rangeY,
    }));
  };

  const pointerDown = (
    event: PointerEvent<HTMLDivElement>,
    axis: "x" | "y",
    ratio: number,
  ): void => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    move(event, axis, ratio);
  };

  const pointerMove = (
    event: PointerEvent<HTMLDivElement>,
    axis: "x" | "y",
    ratio: number,
  ): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.stopPropagation();
    move(event, axis, ratio);
  };

  const lockButton = (axis: "x" | "y", locked: boolean): ReactNode => (
    <button
      type="button"
      className={`canvas-axis-lock ${axis === "x" ? "horizontal" : "vertical"}`}
      aria-label={`${locked ? "Unlock" : "Lock"} ${axis === "x" ? "horizontal" : "vertical"} canvas movement`}
      aria-pressed={locked}
      title={`${locked ? "Unlock" : "Lock"} ${axis === "x" ? "horizontal" : "vertical"} movement`}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={() => onToggleLock(axis)}
    >
      {locked ? <Lock size={12} /> : <Unlock size={12} />}
    </button>
  );

  return (
    <div className="canvas-scrollbars" aria-label="Canvas scroll controls">
      {overflowsX ? (
        <div
          className="canvas-scrollbar horizontal"
          data-active={active.x && !lockedX}
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
      ) : null}
      {overflowsY ? (
        <div
          className="canvas-scrollbar vertical"
          data-active={active.y && !lockedY}
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
      ) : null}
      {canLockX ? lockButton("x", lockedX) : null}
      {canLockY ? lockButton("y", lockedY) : null}
    </div>
  );
}
