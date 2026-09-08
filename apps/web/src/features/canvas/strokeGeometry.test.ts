import { expect, it } from "vitest";
import { pressureStrokePaths } from "./strokeGeometry";

it("bounds a long pressure stroke to 33 SVG paths without discarding its samples", () => {
  const points = Array.from({ length: 10_001 }, (_, i) => ({
    x: i,
    y: i % 100,
    pressure: (i % 101) / 100,
  }));
  const paths = pressureStrokePaths(points, 2.5);
  expect(paths.length).toBeLessThanOrEqual(33);
  expect(
    paths.reduce(
      (count, path) => count + (path.d.match(/M /g)?.length ?? 0),
      0,
    ),
  ).toBe(10_000);
  expect(paths.every((path) => path.width >= 0.5 && path.width <= 3.25)).toBe(
    true,
  );
});
