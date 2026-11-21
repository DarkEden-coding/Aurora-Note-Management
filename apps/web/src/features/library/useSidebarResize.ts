// Drag-to-resize for the library sidebar. The width follows the pointer directly on the element and is saved per device on release.
import { useRef, useState, type CSSProperties, type PointerEvent } from "react";

const STORAGE_KEY = "aurora.sidebarWidth";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 220;
const MAX_WIDTH = 520;

const clampWidth = (width: number) =>
  Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));

function readWidth(): number {
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  return stored ? clampWidth(stored) : DEFAULT_WIDTH;
}

export function useSidebarResize() {
  const sidebarRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(readWidth);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const save = (next: number) => {
    setWidth(next);
    localStorage.setItem(STORAGE_KEY, String(next));
  };
  const widthAt = (event: PointerEvent) =>
    drag.current
      ? clampWidth(
          drag.current.startWidth + event.clientX - drag.current.startX,
        )
      : width;

  return {
    sidebarRef,
    style: { "--sidebar-width": `${width}px` } as CSSProperties,
    handleProps: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width };
        sidebarRef.current?.classList.add("resizing");
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        sidebarRef.current?.style.setProperty(
          "--sidebar-width",
          `${widthAt(event)}px`,
        );
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        const next = widthAt(event);
        drag.current = null;
        sidebarRef.current?.classList.remove("resizing");
        save(next);
      },
      onDoubleClick: () => save(DEFAULT_WIDTH),
    },
  };
}
