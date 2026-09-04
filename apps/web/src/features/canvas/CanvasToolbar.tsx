// Floating tool palette and zoom chrome for the canvas workspace. Presentation only; tool state stays in CanvasWorkspace.
import { type ReactNode } from "react";
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Hand,
  Maximize,
  MousePointer2,
  Pen,
  Plus,
  Redo2,
  Slash,
  Square,
  StickyNote,
  Type,
  Minus,
  Undo2,
} from "lucide-react";
export type CanvasTool =
  | "select"
  | "pan"
  | "pen"
  | "eraser"
  | "line"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "sticky"
  | "text";

export interface CanvasToolbarProps {
  tool: CanvasTool;
  zoom: number;
  objectCount: number;
  maxObjectCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onToolChange: (tool: CanvasTool) => void;
  onUndo: () => void;
  onRedo: () => void;
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
  { tool: "eraser", label: "Erase stroke (X)", icon: <Eraser size={16} /> },
  { tool: "text", label: "Text (T)", icon: <Type size={16} /> },
  { tool: "line", label: "Line (L)", icon: <Slash size={16} /> },
  { tool: "rectangle", label: "Rectangle (R)", icon: <Square size={16} /> },
  { tool: "ellipse", label: "Ellipse (E)", icon: <Circle size={16} /> },
  { tool: "arrow", label: "Arrow (A)", icon: <ArrowUpRight size={16} /> },
  { tool: "sticky", label: "Sticky note (S)", icon: <StickyNote size={16} /> },
];

export function CanvasToolbar({
  tool,
  zoom,
  objectCount,
  maxObjectCount,
  canUndo,
  canRedo,
  onToolChange,
  onUndo,
  onRedo,
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
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
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
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={onZoomOut}
          >
            <Minus size={16} />
          </button>
          <button
            type="button"
            title="Reset zoom"
            aria-label="Reset zoom"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={onZoomReset}
          >
            <Maximize size={16} />
          </button>
          <button
            type="button"
            title="Zoom in"
            aria-label="Zoom in"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={onZoomIn}
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="canvas-toolbar-divider" />
        <div className="canvas-toolbar-group">
          <button
            type="button"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            disabled={!canUndo}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={onUndo}
          >
            <Undo2 size={16} />
          </button>
          <button
            type="button"
            title="Redo (Ctrl+Shift+Z)"
            aria-label="Redo"
            disabled={!canRedo}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={onRedo}
          >
            <Redo2 size={16} />
          </button>
        </div>
      </div>
      <div className="canvas-statusbar" data-testid="canvas-status">
        <span>{Math.round(zoom * 100)}%</span>
        <span>
          {objectCount}/{maxObjectCount} objects
        </span>
      </div>
    </>
  );
}
