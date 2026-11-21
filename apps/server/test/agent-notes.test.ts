// Agent library tools: page layout for any note, typed-text extraction, annotation placement, rendering, and tool discovery.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CanvasObject } from "@aurora/shared";
import { canvasTiles, pagedNotePages } from "../src/agent/pages.js";
import { annotationObjects } from "../src/agent/notes.js";
import { objectText, textToDoc } from "../src/canvas/text.js";
import { buildPageSvg } from "../src/practice/render.js";
import { practiceTagOf } from "../src/practice/marks.js";
import { buildPracticeMcpServer } from "../src/practice/mcp-tools.js";

const ownerId = "55555555-5555-4555-8555-555555555555";
const noteId = "22222222-2222-4222-8222-222222222222";

function object(
  kind: CanvasObject["kind"],
  bounds: CanvasObject["bounds"],
  payload: Record<string, unknown>,
): CanvasObject {
  return {
    id: crypto.randomUUID(),
    ownerId,
    noteId,
    pageId: null,
    kind,
    bounds,
    rotation: 0,
    zIndex: 0,
    locked: false,
    groupId: null,
    payload,
    revision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("note pages", () => {
  it("uses the persisted page count and any page that content reaches", () => {
    const pages = pagedNotePages(1, [
      { x: 10, y: 2 * 1080 + 40, width: 50, height: 20 },
    ]);
    expect(pages.map((p) => p.origin)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1080 },
      { x: 0, y: 2160 },
    ]);
  });

  it("cuts a canvas into page-sized tiles that hold content, in reading order", () => {
    const tiles = canvasTiles([
      { x: -100, y: 1100, width: 50, height: 50 },
      { x: 700, y: 20, width: 200, height: 40 },
    ]);
    expect(tiles).toEqual([
      { index: 0, origin: { x: 0, y: 0 } },
      { index: 1, origin: { x: 816, y: 0 } },
      { index: 2, origin: { x: -816, y: 1056 } },
    ]);
    expect(canvasTiles([])).toEqual([{ index: 0, origin: { x: 0, y: 0 } }]);
  });
});

describe("typed text", () => {
  it("reads rich-text docs, sticky notes and practice cards", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "Momentum" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "p = " },
            { type: "text", text: "mv", marks: [{ type: "bold" }] },
          ],
        },
      ],
    };
    const box = { x: 0, y: 0, width: 100, height: 50 };
    expect(objectText(object("rich-text", box, { doc }))).toBe(
      "Momentum\np = mv",
    );
    expect(
      objectText(object("sticky-note", box, { text: "Exam Friday" })),
    ).toBe("Exam Friday");
    expect(
      objectText(
        object("practice-card", box, { html: "<p>2 &lt; 3</p><p>B</p>" }),
      ),
    ).toBe("2 < 3\nB");
    expect(objectText(object("stroke", box, { points: [] }))).toBeNull();
    expect(
      objectText(object("rich-text", box, { doc: textToDoc("a\nb") })),
    ).toBe("a\nb");
  });
});

describe("annotations", () => {
  it("places marks and typed text relative to the page origin, unlocked", () => {
    const page = { index: 2, origin: { x: -816, y: 1056 } };
    const [circle, text] = annotationObjects(
      ownerId,
      noteId,
      page,
      [{ type: "circle", x: 40, y: 300, width: 120, height: 60 }],
      [{ x: 100, y: 50, width: 300, text: "Check units" }],
    );
    expect(circle!.bounds).toEqual({
      x: -776,
      y: 1356,
      width: 120,
      height: 60,
    });
    expect(circle!.locked).toBe(false);
    expect(practiceTagOf(circle!)).toEqual({
      questionId: null,
      attempt: 1,
      role: "mark",
    });
    expect(text!.kind).toBe("rich-text");
    expect(text!.bounds).toMatchObject({ x: -716, y: 1106, width: 300 });
    expect(objectText(text!)).toBe("Check units");
  });

  it("renders a canvas tile in page coordinates with its typed text", () => {
    const frame = { x: 816, y: 1056, width: 816, height: 1056 };
    const svg = buildPageSvg(
      [
        object(
          "rich-text",
          { x: 900, y: 1100, width: 300, height: 40 },
          { doc: textToDoc("Newton's 2nd law") },
        ),
      ],
      { pageIndex: 0, attempt: 1, frame },
    );
    expect(svg).toContain("translate(-816 -1056)");
    expect(svg).toContain("Newton's 2nd law");
  });
});

describe("MCP discovery", () => {
  it("lists the library tools next to the practice tools", async () => {
    const server = buildPracticeMcpServer("https://aurora.test", 900);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "practice_list_sessions",
        "notes_list",
        "notes_search",
        "notes_read",
        "notes_create",
        "notes_rename",
        "notes_add_page",
        "notes_annotate",
      ]),
    );
    expect(client.getInstructions()).toContain("notes_read");
    await client.close();
  });
});
