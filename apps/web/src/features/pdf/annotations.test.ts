// Focused tests for page-relative annotation geometry and live page reference (de)serialization.
import { describe, expect, it } from "vitest";
import type { Bounds } from "@aurora/shared";
import {
  describePageReference,
  fromPageRelative,
  parseLivePageReference,
  rectFromPageRelative,
  rectToPageRelative,
  serializeLivePageReference,
  toPageRelative,
} from "./annotations";

const PAGE: Bounds = { x: 100, y: 200, width: 400, height: 800 };

describe("page-relative geometry", () => {
  it("round-trips points through page-relative fractions", () => {
    const p = { x: 200, y: 400 };
    const rel = toPageRelative(p, PAGE);
    expect(rel).toEqual({ x: 0.25, y: 0.25 });
    expect(fromPageRelative(rel, PAGE)).toEqual(p);
  });

  it("clamps to the page and guards zero-size pages", () => {
    expect(toPageRelative({ x: -50, y: 2000 }, PAGE)).toEqual({ x: 0, y: 1 });
    expect(
      toPageRelative({ x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 0 }),
    ).toEqual({ x: 0, y: 0 });
  });

  it("round-trips rects through page-relative fractions", () => {
    const b: Bounds = { x: 100, y: 200, width: 200, height: 400 };
    const rel = rectToPageRelative(b, PAGE);
    expect(rel).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(rectFromPageRelative(rel, PAGE)).toEqual(b);
  });
});

describe("live page references", () => {
  it("parses valid payloads and rejects invalid ones", () => {
    expect(
      parseLivePageReference({ sourceNoteId: "note-1", pageNumber: 2 }),
    ).toEqual({
      sourceNoteId: "note-1",
      pageNumber: 2,
    });
    expect(parseLivePageReference({})).toBeNull();
    expect(
      parseLivePageReference({ sourceNoteId: "", pageNumber: 1 }),
    ).toBeNull();
    expect(
      parseLivePageReference({ sourceNoteId: "note-1", pageNumber: 0 }),
    ).toBeNull();
    expect(
      parseLivePageReference({ sourceNoteId: "note-1", pageNumber: 1.5 }),
    ).toBeNull();
  });

  it("preserves optional rect and pdfUrl through serialization", () => {
    const ref = {
      sourceNoteId: "note-1",
      pageNumber: 3,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      pdfUrl: "/files/abc.pdf",
    };
    const payload = serializeLivePageReference(ref);
    expect(parseLivePageReference(payload)).toEqual(ref);
  });

  it("describes references with a short note and page number", () => {
    expect(
      describePageReference({ sourceNoteId: "abcdefgh1234", pageNumber: 7 }),
    ).toBe("→ abcdefgh #7");
  });
});
