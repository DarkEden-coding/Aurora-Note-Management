// Floating tool palette and zoom chrome for the canvas workspace. Presentation only; tool state stays in CanvasWorkspace.
import { type ReactNode } from "react";
import {
  ArrowUpRight,
  Circle,
  Hand,
  Maximize,
  MousePointer2,
  Pen,
  Plus,
  Slash,
  Square,
  StickyNote,
  Type,
  Minus,
} from "lucide-react";
import type { CanvasMode } from "@aurora/shared";

export type CanvasTool =
  | "select"
  | "pan"
  | "pen"
  | "line"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "sticky"
  | "text";

export interface CanvasToolbarProps {
  tool: CanvasTool;
  mode: CanvasMode;
  zoom: number;
  objectCount: number;
  maxObjectCount: number;
  onToolChange: (tool: CanvasTool) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

interface ToolButton {
  tool: CanvasTool;
  label: string;
  icon: ReactNode;
}

const TOOLS: ToolButton[] = [
  { tool: "select", label: "Select (V)", icon: <MousePointer2 size={16} /> },
  { tool: "pan", label: "Pan (H)", icon: <Hand size={16} /> },
  { tool: "pen", label: "Pen (P)", icon: <Pen size={16} /> },
  { tool: "text", label: "Text (T)", icon: <Type size={16} /> },
  { tool: "line", label: "Line (L)", icon: <Slash size={16} /> },
  { tool: "rectangle", label: "Rectangle (R)", icon: <Square size={16} /> },
  { tool: "ellipse", label: "Ellipse (E)", icon: <Circle size={16} /> },
  { tool: "arrow", label: "Arrow (A)", icon: <ArrowUpRight size={16} /> },
  { tool: "sticky", label: "Sticky note (S)", icon: <StickyNote size={16} /> },
];

export function CanvasToolbar({
  tool,
  mode,
  zoom,
  objectCount,
  maxObjectCount,
  onToolChange,
  onZoomIn,
  onZoomOut,
  onZoomReset,
}: CanvasToolbarProps): ReactNode {
  return (
    <>
      <div className="canvas-toolbar" role="toolbar" aria-label="Canvas tools">
        <div className="canvas-toolbar-group">
          {TOOLS.map((button) => (
            <button
              key={button.tool}
              type="button"
              title={button.label}
              aria-label={button.label}
              aria-pressed={tool === button.tool}
              data-active={tool === button.tool ? "true" : "false"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onToolChange(button.tool)}
            >
              {button.icon}
            </button>
          ))}
        </div>
        <div className="canvas-toolbar-divider" />
        <div className="canvas-toolbar-group">
          <button
            type="button"
            title="Zoom out"
            aria-label="Zoom out"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onZoomOut}
          >
            <Minus size={16} />
          </button>
          <button
            type="button"
            title="Reset zoom"
            aria-label="Reset zoom"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onZoomReset}
          >
            <Maximize size={16} />
          </button>
          <button
            type="button"
            title="Zoom in"
            aria-label="Zoom in"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onZoomIn}
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
      <div className="canvas-statusbar" data-testid="canvas-status">
        <span>{modeLabel(mode)}</span>
        <span>{Math.round(zoom * 100)}%</span>
        <span>
          {objectCount}/{maxObjectCount} objects
        </span>
      </div>
    </>
  );
}

function modeLabel(mode: CanvasMode): string {
  switch (mode) {
    case "fixed-width":
      return "Fixed width";
    case "fixed-height":
      return "Fixed height";
    case "paged":
      return "Paged";
    case "infinite":
    default:
      return "Infinite";
  }
}
