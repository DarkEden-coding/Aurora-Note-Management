// Reusable account-palette control for every drawing property panel. The parent owns persistence.
import {
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { DrawingPalette } from "@aurora/shared";
import { Plus, Trash2, X } from "lucide-react";

const MAX_COLORS = 64;

export interface DrawingColorPaletteProps {
  /** Ordered account palette to render. */
  palette: DrawingPalette;
  /** The color currently applied by the containing drawing panel. */
  selectedColor?: string;
  /** Called when a swatch is chosen. */
  onSelect?: (color: string) => void;
  /** Called with a valid, ordered replacement palette. */
  onChange: (palette: DrawingPalette) => void | Promise<void>;
  disabled?: boolean;
}

/** Moves one palette color while preserving the rest of the order. */
function moveColor(
  palette: DrawingPalette,
  from: number,
  to: number,
): DrawingPalette {
  if (from === to) return palette;
  const next = [...palette];
  const [color] = next.splice(from, 1);
  if (!color) return palette;
  next.splice(to, 0, color);
  return next;
}

/** Shared color chooser and editor for drawing property panels. */
export function DrawingColorPalette({
  palette,
  selectedColor,
  onSelect,
  onChange,
  disabled = false,
}: DrawingColorPaletteProps) {
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const dragIndexRef = useRef<number | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragMovedRef = useRef(false);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Persists a palette edit and reports save failures beside the controls. */
  const commit = (next: DrawingPalette): void => {
    paletteRef.current = next;
    setError(null);
    void Promise.resolve(onChange(next)).catch((reason: unknown) => {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not save the drawing palette. Please try again.",
      );
    });
  };

  /** Finishes a pointer-driven reorder. */
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (dragPointerIdRef.current !== event.pointerId) return;
    dragIndexRef.current = null;
    dragPointerIdRef.current = null;
    setDraggingIndex(null);
  };

  /** Reorders a color when a dragged swatch crosses another swatch. */
  const updateDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const from = dragIndexRef.current;
    if (from === null || dragPointerIdRef.current !== event.pointerId) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const swatch =
      target instanceof Element
        ? target.closest("[data-drawing-palette-index]")
        : null;
    const rawIndex = swatch?.getAttribute("data-drawing-palette-index");
    const to =
      rawIndex === null || rawIndex === undefined ? NaN : Number(rawIndex);
    const currentPalette = paletteRef.current;
    if (
      !Number.isInteger(to) ||
      to < 0 ||
      to >= currentPalette.length ||
      to === from
    )
      return;
    dragMovedRef.current = true;
    commit(moveColor(currentPalette, from, to));
    dragIndexRef.current = to;
    setDraggingIndex(to);
  };

  /** Adds the native color picker's result immediately, without a second confirmation. */
  const addColor = (event: ChangeEvent<HTMLInputElement>): void => {
    const color = event.currentTarget.value.toLowerCase();
    if (palette.some((existing) => existing.toLowerCase() === color)) {
      setError("That color is already in the palette.");
      return;
    }
    commit([...palette, color] as DrawingPalette);
  };

  return (
    <div className="drawing-color-palette" aria-label="Drawing color palette">
      <div className="drawing-color-palette-header">
        <span>Color</span>
        <button
          type="button"
          className="drawing-color-palette-edit"
          data-active={editing}
          aria-label={editing ? "Finish editing colors" : "Remove colors"}
          aria-pressed={editing}
          disabled={disabled}
          onClick={() => setEditing((current) => !current)}
        >
          {editing ? "Done" : <Trash2 size={14} />}
        </button>
      </div>
      <div className="drawing-color-palette-swatches" role="list">
        {palette.map((color, index) => (
          <div
            className="drawing-color-palette-swatch-wrap"
            role="listitem"
            key={color}
          >
            <button
              type="button"
              className={`drawing-color-palette-swatch${selectedColor?.toLowerCase() === color.toLowerCase() ? " is-selected" : ""}${draggingIndex === index ? " is-dragging" : ""}`}
              style={{ backgroundColor: color }}
              aria-label={`Use ${color}`}
              aria-pressed={
                selectedColor?.toLowerCase() === color.toLowerCase()
              }
              data-drawing-palette-index={index}
              disabled={disabled || editing}
              onClick={() => {
                if (!dragMovedRef.current) onSelect?.(color);
                dragMovedRef.current = false;
              }}
              onPointerDown={(event) => {
                dragMovedRef.current = false;
                dragIndexRef.current = index;
                dragPointerIdRef.current = event.pointerId;
                setDraggingIndex(index);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={updateDrag}
              onPointerUp={finishDrag}
              onPointerCancel={() => {
                dragIndexRef.current = null;
                dragPointerIdRef.current = null;
                setDraggingIndex(null);
              }}
            />
            {editing ? (
              <button
                type="button"
                className="drawing-color-palette-remove"
                onClick={() =>
                  commit(
                    palette.filter(
                      (_, itemIndex) => itemIndex !== index,
                    ) as DrawingPalette,
                  )
                }
                disabled={disabled || palette.length === 1}
                aria-label={`Remove ${color}`}
              >
                <X size={11} />
              </button>
            ) : null}
          </div>
        ))}
        {!editing ? (
          <label
            className="drawing-color-palette-add"
            role="listitem"
            aria-label="Add drawing color"
            title="Add color"
          >
            <Plus size={17} />
            <input
              type="color"
              defaultValue="#738cff"
              disabled={disabled || palette.length >= MAX_COLORS}
              aria-label="Add drawing color"
              onClick={() => setError(null)}
              onChange={addColor}
            />
          </label>
        ) : null}
      </div>
      {editing ? (
        <p className="drawing-color-palette-hint">
          Select × to remove a color.
        </p>
      ) : null}
      {error ? (
        <p className="drawing-color-palette-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
