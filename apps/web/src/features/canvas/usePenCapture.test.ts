// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { usePenCapture, type UsePenCaptureResult } from "./usePenCapture";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let result: UsePenCaptureResult;
let renders = 0;
const saved = vi.fn();
const context = {
  canvas: { width: 800, height: 600 },
  setTransform: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  clearRect: vi.fn(),
};
function Harness() {
  renders++;
  const containerRef = useRef<HTMLDivElement>(null);
  result = usePenCapture({
    isActive: true,
    noteId: "test",
    containerRef,
    toCanvas: (p) => ({ x: p.x / 2 + 10, y: p.y / 2 + 20 }),
    zoom: 2,
    color: "#123456",
    baseWidth: 2.5,
    onStrokeComplete: saved,
  });
  return createElement(
    "div",
    { ref: containerRef, ...result.handlers },
    createElement("canvas", { ref: result.previewRef }),
  );
}
function event(
  type: string,
  x: number,
  y: number,
  extra: Record<string, unknown> = {},
) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, {
    pointerId: 1,
    pointerType: "pen",
    clientX: x,
    clientY: y,
    pressure: 0.7,
    button: 0,
    ...extra,
  });
  return e;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as never,
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  renders = 0;
  saved.mockClear();
  await act(async () => root.render(createElement(Harness)));
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("paints 1000 samples incrementally without rerendering React and saves full world coordinates", async () => {
  const target = host.firstElementChild!;
  const initialRenders = renders;
  await act(async () => {
    target.dispatchEvent(event("pointerdown", 0, 0));
    for (let i = 1; i <= 1000; i++)
      target.dispatchEvent(event("pointermove", i, i));
  });
  expect(renders).toBe(initialRenders);
  expect(context.stroke).toHaveBeenCalledTimes(1000);
  expect(saved).not.toHaveBeenCalled();
  await act(async () => target.dispatchEvent(event("pointerup", 1001, 1001)));
  const points = saved.mock.calls[0]![0];
  expect(points).toHaveLength(1002);
  expect(points[0]).toEqual({ x: 10, y: 20, pressure: 0.7 });
  expect(points.at(-1)).toEqual({ x: 510.5, y: 520.5, pressure: 0.7 });
});

it("deduplicates raw/coalesced samples, ignores a second pointer, and discards cancelled ink", async () => {
  const target = host.firstElementChild!;
  await act(async () => {
    target.dispatchEvent(event("pointerdown", 10, 10));
    target.dispatchEvent(event("pointerrawupdate", 20, 20));
    target.dispatchEvent(event("pointermove", 20, 20));
    target.dispatchEvent(event("pointermove", 30, 30, { pointerId: 2 }));
  });
  expect(context.stroke).toHaveBeenCalledTimes(1);
  await act(async () => target.dispatchEvent(event("pointercancel", 20, 20)));
  expect(result.isDrawing()).toBe(false);
  expect(saved).not.toHaveBeenCalled();
  expect(context.clearRect).toHaveBeenCalled();
});

it("keeps coalesced samples and saves a pen tap", async () => {
  const target = host.firstElementChild!;
  await act(async () => {
    target.dispatchEvent(event("pointerdown", 10, 10));
    target.dispatchEvent(
      event("pointermove", 40, 40, {
        getCoalescedEvents: () => [
          event("pointermove", 20, 20),
          event("pointermove", 30, 30),
        ],
      }),
    );
    target.dispatchEvent(event("pointerup", 40, 40));
  });
  expect(saved.mock.calls[0]![0]).toHaveLength(4);
  saved.mockClear();
  await act(async () => {
    target.dispatchEvent(event("pointerdown", 50, 50));
    target.dispatchEvent(event("pointerup", 50, 50));
  });
  expect(saved.mock.calls[0]![0]).toHaveLength(1);
});
