// Floating tool palette and zoom chrome for the canvas workspace. Presentation only; tool state stays in CanvasWorkspace.
import { type ReactNode } from "react";
import {
  ArrowUpRight,
  Brackets,
  Camera,
  ClipboardPaste,
  Circle,
  Eraser,
  Hand,
  Highlighter,
  LassoSelect,
  MousePointer2,
  Pen,
  Redo2,
  Slash,
  Square,
  Type,
  Undo2,
} from "lucide-react";
export type CanvasTool =
  | "select"
  | "lasso"
  | "pan"
  | "pen"
  | "highlighter"
  | "eraser"
  | "line"
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "matrix"
  | "text";

export interface CanvasToolbarProps {
  tool: CanvasTool;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  onToolChange: (tool: CanvasTool) => void;
  onUndo: () => void;
  onRedo: () => void;
  onPaste: () => void;
  onScan: () => void;
}

interface ToolButton {
  tool: CanvasTool;
  label: string;
  icon: ReactNode;
}

const TOOLS: ToolButton[] = [
  { tool: "select", label: "Select (V)", icon: <MousePointer2 size={16} /> },
  { tool: "lasso", label: "Lasso select (S)", icon: <LassoSelect size={16} /> },
  { tool: "pan", label: "Pan (H)", icon: <Hand size={16} /> },
  { tool: "pen", label: "Pen (P)", icon: <Pen size={16} /> },
  {
    tool: "highlighter",
    label: "Highlighter (I)",
    icon: <Highlighter size={16} />,
  },
  { tool: "eraser", label: "Erase stroke (X)", icon: <Eraser size={16} /> },
  { tool: "text", label: "Text (T)", icon: <Type size={16} /> },
  { tool: "line", label: "Line (L)", icon: <Slash size={16} /> },
  { tool: "rectangle", label: "Rectangle (R)", icon: <Square size={16} /> },
  { tool: "ellipse", label: "Ellipse (E)", icon: <Circle size={16} /> },
  { tool: "arrow", label: "Arrow (A)", icon: <ArrowUpRight size={16} /> },
  {
    tool: "matrix",
    label: "Matrix brackets (M)",
    icon: <Brackets size={16} />,
  },
];

export function CanvasToolbar({
  tool,
  zoom,
  canUndo,
  canRedo,
  canPaste,
  onToolChange,
  onUndo,
  onRedo,
  onPaste,
  onScan,
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
          <button
            type="button"
            title="Paste (Ctrl+V)"
            aria-label="Paste"
            disabled={!canPaste}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={onPaste}
          >
            <ClipboardPaste size={16} />
          </button>
          <button
            type="button"
            title="Scan with camera"
            aria-label="Scan with camera"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={onScan}
          >
            <Camera size={16} />
          </button>
        </div>
      </div>
      <div className="canvas-statusbar" data-testid="canvas-status">
        <span>{Math.round(zoom * 100)}%</span>
      </div>
    </>
  );
}
