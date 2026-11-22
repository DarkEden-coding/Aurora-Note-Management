import { describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-js";
import { markToObjects } from "../src/practice/marks.js";
import { buildPageSvg } from "../src/practice/render.js";
import {
  RENDER_FONT_OPTIONS,
  fitFontSize,
  measureText,
  wrapText,
} from "../src/practice/textLayout.js";

const ctx = {
  ownerId: "55555555-5555-4555-8555-555555555555",
  noteId: "22222222-2222-4222-8222-222222222222",
  pageIndex: 0,
};
const sans = { fontFamily: "sans" } as const;

describe("server text layout", () => {
  it("draws sans text in the bundled Roboto, not a serif fallback", () => {
    const width = (family: string) =>
      new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text y="20" font-family="${family}" font-size="20">Units per second</text></svg>`,
        { font: RENDER_FONT_OPTIONS },
      ).getBBox()!.width;
    expect(measureText("Units per second", sans, 20)).toBeCloseTo(
      width("Roboto"),
    );
    expect(RENDER_FONT_OPTIONS.loadSystemFonts).toBe(false);
  });

  it("wraps words inside the box width and breaks words longer than a line", () => {
    const text =
      "Final answer still isn't in the box above, so write it there before pressing Done.";
    const lines = wrapText(text, 220, sans, 20);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines)
      expect(measureText(line, sans, 20)).toBeLessThanOrEqual(220);
    expect(lines.join(" ")).toBe(text);
    const long = wrapText("x".repeat(80), 100, sans, 20);
    expect(long.length).toBeGreaterThan(1);
    for (const line of long)
      expect(measureText(line, sans, 20)).toBeLessThanOrEqual(100);
  });

  it("keeps an agent label near the right page edge inside the page in the image", () => {
    const [label] = markToObjects(
      ctx,
      {
        type: "text",
        x: 600,
        y: 300,
        width: 200,
        text: "Check the sign of the potential energy term here",
      },
      null,
      1,
    );
    const svg = buildPageSvg([label!], { pageIndex: 0, attempt: 1 });
    const texts = [...svg.matchAll(/<text x="600"[^>]*>([^<]*)<\/text>/g)].map(
      (match) => match[1]!,
    );
    expect(texts.length).toBeGreaterThan(1);
    for (const line of texts) {
      expect(600 + measureText(line, sans, 20)).toBeLessThanOrEqual(800);
    }
    // The label card is tall enough for every wrapped line.
    expect(label!.bounds.height).toBeGreaterThanOrEqual(texts.length * 25);
  });

  it("shrinks rich text to fit its box like the app", () => {
    const text =
      "A long note that cannot fit at its full size in this small box";
    const size = fitFontSize(text, { width: 120, height: 40 }, sans, 24, 1.2);
    expect(size).toBeLessThan(24);
    expect(
      wrapText(text, 120, sans, size).length * size * 1.2,
    ).toBeLessThanOrEqual(40.5);
    expect(fitFontSize("Hi", { width: 120, height: 40 }, sans, 24, 1.2)).toBe(
      24,
    );
  });
});
