/**
 * Fit the document using layout-space measurements so canvas zoom has no effect.
 * maxFontSize (a box's chosen font size) caps the fitted size; text still shrinks to fit.
 */
export function fitText(
  block: HTMLElement,
  surface: HTMLElement,
  empty: boolean,
  maxFontSize?: number,
): void {
  const width = block.clientWidth;
  const height = block.clientHeight;
  if (width <= 0 || height <= 0) return;
  // Empty boxes retain a comfortable insertion caret. Dense documents remain
  // scrollable at the minimum size instead of disappearing into unreadable text.
  if (empty) {
    surface.style.fontSize = `${maxFontSize ?? 16}px`;
    return;
  }
  let low = 8;
  let high = Math.max(8, Math.min(height / 1.2, maxFontSize ?? Infinity));
  for (let i = 0; i < 14; i += 1) {
    const size = (low + high) / 2;
    surface.style.fontSize = `${size}px`;
    if (surface.scrollHeight <= height && surface.scrollWidth <= width)
      low = size;
    else high = size;
  }
  surface.style.fontSize = `${Math.floor(low * 10) / 10}px`;
}
