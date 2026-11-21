// Live selection drag: shows the move with per-element transforms so a drag of
// many objects never rebuilds stroke geometry or re-renders the canvas per frame.
import type { Bounds, CanvasMode } from "@aurora/shared";
import type { Point } from "./viewport";
import { translateBoundsInMode } from "./pageLayout";

/** Elements tagged with this attribute follow their object during a drag. */
export const MOVE_TARGET_ATTRIBUTE = "data-move-id";

/** Each object's offset after page clamping, keyed by object id. */
export function clampedMoveOffsets(
  origins: ReadonlyMap<string, Bounds>,
  delta: Point,
  mode: CanvasMode,
): Map<string, Point> {
  const offsets = new Map<string, Point>();
  for (const [id, origin] of origins) {
    const moved = translateBoundsInMode(origin, delta.x, delta.y, mode);
    offsets.set(id, { x: moved.x - origin.x, y: moved.y - origin.y });
  }
  return offsets;
}

function moveTargets(root: ParentNode, id: string): NodeListOf<Element> {
  return root.querySelectorAll(
    `[${MOVE_TARGET_ATTRIBUTE}="${CSS.escape(id)}"]`,
  );
}

function setOffset(element: Element, offset: Point | null): void {
  if (element instanceof SVGElement) {
    if (offset === null) element.removeAttribute("transform");
    else element.setAttribute("transform", `translate(${offset.x} ${offset.y})`);
  } else if (element instanceof HTMLElement) {
    // `translate` composes with the object's own `rotate` style.
    element.style.translate =
      offset === null ? "" : `${offset.x}px ${offset.y}px`;
  }
}

/** Shifts every rendered part of the dragged objects by its clamped offset. */
export function applyMoveOffsets(
  root: ParentNode,
  offsets: ReadonlyMap<string, Point>,
): void {
  for (const [id, offset] of offsets) {
    for (const element of moveTargets(root, id)) setOffset(element, offset);
  }
}

/** Removes drag offsets once the real positions are rendered or the drag is cancelled. */
export function clearMoveOffsets(
  root: ParentNode,
  ids: Iterable<string>,
): void {
  for (const id of ids) {
    for (const element of moveTargets(root, id)) setOffset(element, null);
  }
}
