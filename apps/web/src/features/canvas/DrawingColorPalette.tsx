// Reusable account-palette control for drawing property panels. The parent owns
// persistence so this component can also be used with temporary palettes.
import {
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { DrawingPalette } from "@aurora/shared";

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

/**
 * A keyboard and Pointer Events accessible drawing color chooser/editor.
 * Drag a swatch across another swatch to reorder it, or release it over the
 * add button to delete it. The last color is intentionally not deletable.
 */
export function DrawingColorPalette({
  palette,
  selectedColor,
  onSelect,
  onChange,
  disabled = false,
}: DrawingColorPaletteProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;
  const dragIndexRef = useRef<number | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragMovedRef = useRef(false);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const commit = (next: DrawingPalette) => {
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

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const from = dragIndexRef.current;
    if (from === null || dragPointerIdRef.current !== event.pointerId) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const currentPalette = paletteRef.current;
    if (
      target instanceof Element &&
      target.closest("[data-drawing-palette-add]") &&
      currentPalette.length > 1
    ) {
      dragMovedRef.current = true;
      commit(
        currentPalette.filter((_, index) => index !== from) as DrawingPalette,
      );
    }
    dragIndexRef.current = null;
    dragPointerIdRef.current = null;
    setDraggingIndex(null);
  };

  const updateDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
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

  const addColor = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const color = colorInputRef.current?.value.toLowerCase();
    if (!color) return;
    if (palette.some((existing) => existing.toLowerCase() === color)) {
      setError("That color is already in the palette.");
      return;
    }
    commit([...palette, color] as DrawingPalette);
    dialogRef.current?.close();
  };

  return (
    <div className="drawing-color-palette" aria-label="Drawing color palette">
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
              disabled={disabled}
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
            <div
              className="drawing-color-palette-actions"
              aria-label={`${color} actions`}
            >
              <button
                type="button"
                onClick={() => commit(moveColor(palette, index, index - 1))}
                disabled={disabled || index === 0}
                aria-label={`Move ${color} left`}
              >
                ←
              </button>
              <button
                type="button"
                onClick={() => commit(moveColor(palette, index, index + 1))}
                disabled={disabled || index === palette.length - 1}
                aria-label={`Move ${color} right`}
              >
                →
              </button>
              <button
                type="button"
                onClick={() =>
                  commit(
                    palette.filter(
                      (_, itemIndex) => itemIndex !== index,
                    ) as DrawingPalette,
                  )
                }
                disabled={disabled || palette.length === 1}
                aria-label={`Delete ${color}`}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="drawing-color-palette-add"
          data-drawing-palette-add
          disabled={disabled || palette.length >= MAX_COLORS}
          aria-label="Add drawing color"
          onClick={() => {
            setError(null);
            dialogRef.current?.showModal();
          }}
        >
          +
        </button>
      </div>
      {error ? (
        <p className="drawing-color-palette-error" role="alert">
          {error}
        </p>
      ) : null}
      <dialog
        ref={dialogRef}
        className="drawing-color-palette-dialog"
        aria-label="Add drawing color"
      >
        <form method="dialog" onSubmit={addColor}>
          <label>
            New drawing color
            <input ref={colorInputRef} type="color" defaultValue="#000000" />
          </label>
          <div className="drawing-color-palette-dialog-actions">
            <button type="button" onClick={() => dialogRef.current?.close()}>
              Cancel
            </button>
            <button type="submit">Add color</button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
