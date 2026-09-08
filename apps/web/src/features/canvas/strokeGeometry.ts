import type { StrokePoint } from "./objects";

const PRESSURE_STEPS = 32;

/** Bound SVG element count while retaining pressure to within 1/64 of its range. */
export function pressureStrokePaths(
  points: StrokePoint[],
  baseWidth: number,
): Array<{ d: string; width: number }> {
  const groups = new Map<number, string[]>();
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const level = Math.round(
      Math.max(0, Math.min(1, a.pressure)) * PRESSURE_STEPS,
    );
    let segments = groups.get(level);
    if (!segments) {
      segments = [];
      groups.set(level, segments);
    }
    segments.push(`M ${a.x} ${a.y} L ${b.x} ${b.y}`);
  }
  return [...groups].map(([level, segments]) => ({
    d: segments.join(" "),
    width: Math.max(0.5, baseWidth * (0.3 + level / PRESSURE_STEPS)),
  }));
}
