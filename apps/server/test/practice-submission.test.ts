// Checks what Claude gets with a submission (ink geometry, free space, card regions, crops), re-grading, the progress switch, and the advertised MCP tool parameters.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CanvasObject } from "@aurora/shared";
import { cardObject } from "../src/practice/marks.js";
import { freeRegions, inkClusters } from "../src/practice/geometry.js";
import { buildPageSvg } from "../src/practice/render.js";
import {
  DEFAULT_IMAGE_OPTIONS,
  describePage,
  renderPageImages,
} from "../src/practice/submission.js";
import { planGrade } from "../src/practice/state.js";
import { wantsProgress } from "../src/practice/mcp.js";
import { buildPracticeMcpServer } from "../src/practice/mcp-tools.js";

const ctx = {
  ownerId: "55555555-5555-4555-8555-555555555555",
  noteId: "22222222-2222-4222-8222-222222222222",
  pageIndex: 1,
};
const PAGE_Y = 1080;
const questionId = "11111111-1111-4111-8111-111111111111";

function stroke(
  x: number,
  y: number,
  width: number,
  height: number,
): CanvasObject {
  return {
    id: crypto.randomUUID(),
    ownerId: ctx.ownerId,
    noteId: ctx.noteId,
    pageId: null,
    kind: "stroke",
    bounds: { x, y: PAGE_Y + y, width, height },
    rotation: 0,
    zIndex: 1,
    locked: false,
    groupId: null,
    payload: {
      points: [
        [x, PAGE_Y + y, 0.5],
        [x + width, PAGE_Y + y + height, 0.5],
      ],
      color: "#222222",
      baseWidth: 2.5,
    },
    revision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const prompt = cardObject(
  ctx,
  "prompt",
  "<p>Q</p>",
  { x: 32, y: 32, width: 752, height: 200 },
  { questionId, attempt: 1, role: "prompt" },
);

const pngWidth = (png: Buffer): number => png.readUInt32BE(16);

describe("submission geometry", () => {
  it("clusters nearby strokes and finds free space away from ink and the card", () => {
    const clusters = inkClusters([
      { x: 100, y: 300, width: 80, height: 30 },
      { x: 190, y: 310, width: 60, height: 30 },
      { x: 100, y: 700, width: 100, height: 40 },
    ]);
    expect(clusters).toEqual([
      { x: 100, y: 300, width: 150, height: 40 },
      { x: 100, y: 700, width: 100, height: 40 },
    ]);

    const ink = [{ x: 100, y: 300, width: 300, height: 100 }];
    const card = { x: 32, y: 32, width: 752, height: 200 };
    const free = freeRegions([card, ...ink], ink);
    expect(free.length).toBeGreaterThan(0);
    for (const region of free) {
      for (const taken of [card, ...ink]) {
        const overlaps =
          region.x < taken.x + taken.width &&
          region.x + region.width > taken.x &&
          region.y < taken.y + taken.height &&
          region.y + region.height > taken.y;
        expect(overlaps).toBe(false);
      }
      expect(region.width).toBeGreaterThanOrEqual(128);
      expect(region.height).toBeGreaterThanOrEqual(48);
    }
  });

  it("returns page-relative card, region and ink bounds for the question's page", () => {
    const geometry = describePage(
      [prompt, stroke(120, 150, 60, 40), stroke(100, 400, 200, 50)],
      1,
      [{ kind: "option", label: "B", x: 24, y: 100, width: 300, height: 30 }],
    );
    expect(geometry.card).toEqual({ x: 32, y: 32, width: 752, height: 200 });
    expect(geometry.regions).toEqual([
      { kind: "option", label: "B", x: 56, y: 132, width: 300, height: 30 },
    ]);
    expect(geometry.ink.bounds).toEqual({
      x: 100,
      y: 150,
      width: 200,
      height: 300,
    });
    expect(geometry.ink.clusters).toHaveLength(2);
  });
});

describe("submission images", () => {
  it("draws ink above the question card and outlines labelled regions", () => {
    const circle = stroke(50, 120, 200, 40);
    const svg = buildPageSvg([circle, prompt], {
      pageIndex: 1,
      attempt: 1,
      regions: [
        { kind: "option", label: "A", x: 56, y: 132, width: 300, height: 30 },
      ],
    });
    expect(svg.indexOf("Question card")).toBeLessThan(svg.indexOf(">A</text>"));
    expect(svg.indexOf(">A</text>")).toBeLessThan(
      svg.indexOf('stroke="#222222"'),
    );
  });

  it("crops to the ink with grid labels in page units and adds a final-answer close-up", async () => {
    const objects = [prompt, stroke(300, 520, 120, 60)];
    const geometry = describePage(objects, 1, [
      {
        kind: "finalAnswer",
        label: "final",
        x: 24,
        y: 120,
        width: 400,
        height: 60,
      },
    ]);
    const { page, finalAnswer } = await renderPageImages(
      objects,
      { pageIndex: 1, attempt: 1 },
      geometry,
      { ...DEFAULT_IMAGE_OPTIONS, crop: "ink", scale: 1 },
    );
    // Union of the final-answer box (56..456, 152..212) and ink (300..420, 520..580), padded, snapped.
    expect(page.area).toEqual({
      x: 0,
      y: 100,
      width: 500,
      height: 550,
      scale: 1,
    });
    expect(pngWidth(page.png)).toBe(500);
    const svg = buildPageSvg(objects, { pageIndex: 1, attempt: 1 }, page.area);
    expect(svg).toContain('viewBox="0 100 500 550"');
    expect(svg).toContain('<text x="2" y="198">200</text>');
    expect(svg).toContain('<text x="102" y="110">100</text>');

    expect(finalAnswer?.area).toEqual({
      x: 44,
      y: 140,
      width: 424,
      height: 84,
      scale: 2,
    });
    expect(pngWidth(finalAnswer!.png)).toBe(848);
  });
});

describe("re-grading", () => {
  const facts = { index: 0, attempt: 1, maxPoints: 4, points: 2 };
  it("lets a graded question be re-graded but not a closed one", () => {
    expect(planGrade({ ...facts, state: "graded" }, 3)).toEqual({
      points: 3,
      latestPoints: 3,
    });
    expect(planGrade({ ...facts, state: "graded", attempt: 2 }, 4)).toEqual({
      points: 2,
      latestPoints: 4,
    });
    expect(() => planGrade({ ...facts, state: "closed" }, 3)).toThrow(
      /is closed/,
    );
    expect(() => planGrade({ ...facts, state: "awaiting_work" }, 3)).toThrow(
      /awaiting_work/,
    );
  });
});

describe("practice MCP surface", () => {
  it("streams only requests that carry a progress token", () => {
    const call = (meta?: object) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "practice_wait",
        arguments: {},
        ...(meta ? { _meta: meta } : {}),
      },
    });
    expect(wantsProgress(call())).toBe(false);
    expect(wantsProgress(call({ progressToken: 7 }))).toBe(true);
    expect(wantsProgress([call(), call({ progressToken: "t" })])).toBe(true);
    expect(wantsProgress(undefined)).toBe(false);
  });

  it("advertises the new tool parameters", async () => {
    const server = buildPracticeMcpServer(
      "https://aurora.test",
      900,
      "/tmp/uploads",
    );
    const client = new Client({ name: "test", version: "1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const { tools } = await client.listTools();
    const props = (name: string) =>
      (tools.find((t) => t.name === name)?.inputSchema.properties ??
        {}) as Record<string, { maximum?: number }>;
    expect(props("practice_wait").timeoutSeconds?.maximum).toBe(900);
    expect(Object.keys(props("practice_wait"))).toContain("image");
    expect(Object.keys(props("practice_get_submission"))).toContain("image");
    expect(Object.keys(props("practice_grade"))).toEqual(
      expect.arrayContaining(["dryRun", "image"]),
    );
    expect(Object.keys(props("practice_start"))).toContain("grading");
    expect(Object.keys(props("practice_set_grading"))).toEqual([
      "sessionId",
      "grading",
    ]);
    expect(client.getInstructions()).toContain("freeRegions");
    await client.close();
  });
});
