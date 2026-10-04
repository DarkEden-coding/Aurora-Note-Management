// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useViewport, type UseViewportResult } from "./useViewport";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let result: UseViewportResult;

function Harness({ x = false, y = false }) {
  result = useViewport(
    { x: 10, y: 20, width: 800, height: 600, zoom: 1 },
    { x, y },
  );
  return createElement("div", { ref: result.containerRef });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("blocks gesture and wheel zoom while horizontally locked, but allows vertical pan and zoom after unlock", async () => {
  await act(async () => root.render(createElement(Harness, { x: true })));
  const locked = result.viewport;
  await act(async () => {
    result.zoomAt({ x: 100, y: 100 }, 2);
    host.firstElementChild!.dispatchEvent(
      new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY: -100,
        cancelable: true,
      }),
    );
  });
  expect(result.viewport).toEqual(locked);
  await act(async () => result.panBy(50, 50));
  expect(result.viewport.x).toBe(locked.x);
  expect(result.viewport.y).toBe(locked.y - 50);

  await act(async () => root.render(createElement(Harness, { y: true })));
  await act(async () => result.zoomAt({ x: 100, y: 100 }, 2));
  expect(result.viewport.zoom).toBe(2);
  await act(async () => {
    host.firstElementChild!.dispatchEvent(
      new WheelEvent("wheel", {
        metaKey: true,
        deltaY: -100,
        cancelable: true,
      }),
    );
  });
  expect(result.viewport.zoom).toBeGreaterThan(2);
});
