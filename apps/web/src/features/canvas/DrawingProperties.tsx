import { useEffect, useState, type ReactNode } from "react";
import type { DrawingPalette } from "@aurora/shared";
import { Settings2 } from "lucide-react";
import type { CanvasTool } from "./CanvasToolbar";
import { DrawingColorPalette } from "./DrawingColorPalette";
import type { ShapeLineStyle } from "./objects";

export type VectorTool = "rectangle" | "ellipse" | "line" | "arrow";

export interface DrawingStyle {
  strokeColor: string;
  fillColor: string | null;
  strokeWidth: number;
  lineStyle: ShapeLineStyle;
  cornerRadius: number;
}

interface DrawingStyleControlsProps {
  kind: "pen" | VectorTool;
  style: DrawingStyle;
  palette: DrawingPalette;
  onPaletteChange: (palette: DrawingPalette) => void | Promise<void>;
  onPreview: (patch: Partial<DrawingStyle>) => void;
  onCommit: () => void;
}

/** Shared controls for placement defaults and selected vector objects. */
export function DrawingStyleControls({
  kind,
  style,
  palette,
  onPaletteChange,
  onPreview,
  onCommit,
}: DrawingStyleControlsProps): ReactNode {
  const supportsFill = kind === "rectangle" || kind === "ellipse";
  const [colorTarget, setColorTarget] = useState<"stroke" | "fill">("stroke");

  useEffect(() => {
    if (!supportsFill) setColorTarget("stroke");
  }, [supportsFill]);

  const applyNow = (patch: Partial<DrawingStyle>): void => {
    onPreview(patch);
    onCommit();
  };
  const selectedColor =
    colorTarget === "fill" ? (style.fillColor ?? undefined) : style.strokeColor;

  return (
    <div className="drawing-style-controls">
      {supportsFill ? (
        <div
          className="drawing-color-target"
          role="group"
          aria-label="Color target"
        >
          <button
            type="button"
            data-active={colorTarget === "stroke"}
            onClick={() => setColorTarget("stroke")}
          >
            Outline
          </button>
          <button
            type="button"
            data-active={colorTarget === "fill"}
            onClick={() => setColorTarget("fill")}
          >
            Fill
          </button>
          <button
            type="button"
            data-active={colorTarget === "fill" && style.fillColor === null}
            onClick={() => {
              setColorTarget("fill");
              applyNow({ fillColor: null });
            }}
          >
            No fill
          </button>
        </div>
      ) : null}

      <DrawingColorPalette
        palette={palette}
        {...(selectedColor !== undefined ? { selectedColor } : {})}
        onSelect={(color) =>
          applyNow(
            colorTarget === "fill"
              ? { fillColor: color }
              : { strokeColor: color },
          )
        }
        onChange={onPaletteChange}
      />

      {kind !== "pen" ? (
        <>
          <label className="drawing-property-field">
            Line type
            <select
              value={style.lineStyle}
              onChange={(event) =>
                applyNow({ lineStyle: event.target.value as ShapeLineStyle })
              }
            >
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
            </select>
          </label>
          <label className="drawing-property-field">
            Line width
            <span>
              <input
                type="range"
                min="1"
                max="12"
                step="0.5"
                value={style.strokeWidth}
                onChange={(event) =>
                  onPreview({ strokeWidth: Number(event.target.value) })
                }
                onPointerUp={onCommit}
                onPointerCancel={onCommit}
                onBlur={onCommit}
              />
              <output>{style.strokeWidth}px</output>
            </span>
          </label>
        </>
      ) : null}

      {kind === "rectangle" ? (
        <label className="drawing-property-field">
          Corner radius
          <span>
            <input
              type="range"
              min="0"
              max="64"
              step="1"
              value={style.cornerRadius}
              onChange={(event) =>
                onPreview({ cornerRadius: Number(event.target.value) })
              }
              onPointerUp={onCommit}
              onPointerCancel={onCommit}
              onBlur={onCommit}
            />
            <input
              className="drawing-radius-number"
              type="number"
              min="0"
              max="64"
              value={style.cornerRadius}
              onChange={(event) => {
                const radius = event.target.valueAsNumber;
                if (Number.isFinite(radius)) {
                  onPreview({
                    cornerRadius: Math.max(0, Math.min(64, radius)),
                  });
                }
              }}
              onBlur={onCommit}
            />
          </span>
        </label>
      ) : null}
    </div>
  );
}

/** Left-side defaults shown for active drawing tools. */
export function DrawingPlacementPanel({
  tool,
  ...props
}: Omit<DrawingStyleControlsProps, "kind"> & {
  tool: "pen" | VectorTool;
}): ReactNode {
  return (
    <aside className="drawing-properties-panel" aria-label="Drawing properties">
      <strong className="drawing-properties-title">
        {tool === "pen" ? "Pen" : "Shape"} properties
      </strong>
      <DrawingStyleControls kind={tool} {...props} />
    </aside>
  );
}

/** Button that opens the floating editor for a selected vector object. */
export function ShapePropertiesButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="shape-properties-button"
      aria-label="Edit shape properties"
      aria-expanded={open}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onClick={onToggle}
    >
      <Settings2 size={14} />
    </button>
  );
}
