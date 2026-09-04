/** Time after stylus activity during which browser-reported touch contacts are treated as palms. */
export const PALM_REJECTION_WINDOW_MS = 800;

/** Uses Pointer Events after OS palm rejection to suppress touch contacts near stylus activity. */
export function shouldRejectTouch(
  pointerType: string,
  eventTime: number,
  lastStylusTime: number,
): boolean {
  return (
    pointerType === "touch" &&
    eventTime - lastStylusTime <= PALM_REJECTION_WINDOW_MS
  );
}
