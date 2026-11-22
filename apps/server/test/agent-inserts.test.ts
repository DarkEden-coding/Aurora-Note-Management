// Agent pictures and HTML blocks: image decoding (SVG rasterized, unsafe input refused), HTML block objects and edits, their page render, and practice card page placement.
import { describe, expect, it } from "vitest";
import { describeObject, editObject } from "../src/agent/objects.js";
import {
  decodeAgentImage,
  MAX_AGENT_IMAGE_BYTES,
  sniffImageType,
} from "../src/agent/images.js";
import { htmlBlockObject, imageObject } from "../src/agent/inserts.js";
import { cardObject } from "../src/practice/marks.js";
import { buildPageSvg } from "../src/practice/render.js";
import { planCardPage } from "../src/practice/state.js";
import { describePage } from "../src/practice/submission.js";

const ownerId = "55555555-5555-4555-8555-555555555555";
const noteId = "22222222-2222-4222-8222-222222222222";
const fileId = "33333333-3333-4333-8333-333333333333";
const page0 = { index: 0, origin: { x: 0, y: 0 } };
const page1 = { index: 1, origin: { x: 0, y: 1080 } };

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#1f6feb"/></svg>`;
const base64 = (text: string) => Buffer.from(text).toString("base64");

describe("agent images", () => {
  it("stores raster images as given and turns SVG into PNG at twice the placed width", () => {
    const svg = decodeAgentImage(
      `data:image/svg+xml;base64,${base64(SVG)}`,
      100,
    );
    expect(svg.mimeType).toBe("image/png");
    expect(sniffImageType(svg.bytes)).toBe("image/png");
    expect(svg.bytes.readUInt32BE(16)).toBe(200);

    const png = decodeAgentImage(svg.bytes.toString("base64"), 100);
    expect(png).toEqual({ bytes: svg.bytes, mimeType: "image/png" });
  });

  it("refuses non-images, oversized data and SVGs that link outside themselves", () => {
    expect(() =>
      decodeAgentImage(base64("hello world, not a picture"), 50),
    ).toThrow(/not a PNG/);
    expect(() =>
      decodeAgentImage(
        "A".repeat(Math.ceil((MAX_AGENT_IMAGE_BYTES * 4) / 3) + 200),
        50,
      ),
    ).toThrow(/limited to 5 MB/);
    const external = SVG.replace(
      "<rect",
      `<image href="/etc/passwd" width="1" height="1"/><rect`,
    );
    expect(() => decodeAgentImage(base64(external), 50)).toThrow(/only link/);
  });
});

describe("agent HTML blocks", () => {
  const html = `<style>td { color: red }</style><table><tr><td>$E=mc^2$</td></tr></table>`;

  it("places an unlocked agent HTML card on the page and lists its html", () => {
    const block = htmlBlockObject(
      ownerId,
      noteId,
      page1,
      { x: 40, y: 60, width: 300, height: 120 },
      html,
    );
    expect(block).toMatchObject({
      kind: "practice-card",
      locked: false,
      bounds: { x: 40, y: 1140, width: 300, height: 120 },
      payload: { variant: "html", html, author: "agent" },
    });
    expect(describeObject(block, page1)).toMatchObject({
      variant: "html",
      author: "agent",
      pageIndex: 1,
      x: 40,
      y: 60,
      html,
    });
    // notes_read keeps long HTML (data: images) out of the listing.
    const long = {
      ...block,
      payload: { ...block.payload, html: html.repeat(200) },
    };
    const listed = describeObject(long, page1, { fullHtml: false });
    expect(listed).not.toHaveProperty("html");
    expect(listed).toMatchObject({ htmlLength: html.length * 200 });
  });

  it("refuses blocks that leave the page", () => {
    expect(() =>
      htmlBlockObject(
        ownerId,
        noteId,
        page0,
        { x: 600, y: 0, width: 300, height: 50 },
        html,
      ),
    ).toThrow(/x \+ width/);
  });

  it("edits html, position and picture, and refuses fields an object cannot take", () => {
    const block = htmlBlockObject(
      ownerId,
      noteId,
      page0,
      { x: 40, y: 60, width: 300, height: 120 },
      html,
    );
    const moved = editObject(block, page0, page1, {
      id: block.id,
      html: "<p>New</p>",
      x: 10,
      width: 500,
    });
    expect(moved.payload.html).toBe("<p>New</p>");
    expect(moved.bounds).toEqual({ x: 10, y: 1140, width: 500, height: 120 });
    expect(() =>
      editObject(block, page0, page0, { id: block.id, image: "AAAA" }),
    ).toThrow(/not an image/);

    const picture = imageObject(
      ownerId,
      noteId,
      page0,
      { x: 0, y: 0, width: 100, height: 50 },
      fileId,
      "chart",
    );
    expect(picture.payload).toEqual({ fileId, alt: "chart", author: "agent" });
    const newFile = "44444444-4444-4444-8444-444444444444";
    expect(
      editObject(
        picture,
        page0,
        page0,
        { id: picture.id, image: "AAAA" },
        newFile,
      ).payload.fileId,
    ).toBe(newFile);
    expect(() =>
      editObject(picture, page0, page0, { id: picture.id, html: "<p>x</p>" }),
    ).toThrow(/has no HTML/);
  });

  it("draws a block's text without its stylesheet in page images", () => {
    const block = htmlBlockObject(
      ownerId,
      noteId,
      page0,
      { x: 40, y: 60, width: 300, height: 120 },
      html,
    );
    const svg = buildPageSvg([block], { pageIndex: 0, attempt: 1 });
    expect(svg).toContain("HTML block");
    expect(svg).toContain("$E=mc^2$");
    expect(svg).not.toContain("color: red");
  });
});

describe("practice reference cards", () => {
  const ctx = { ownerId, noteId, pageIndex: 0 };
  const card = cardObject(
    ctx,
    "html",
    "<p>Constants</p>",
    { x: 32, y: 32, width: 300, height: 100 },
    { questionId: null, attempt: 1, role: "info" },
  );

  it("never fades on a retry and is not counted as the user's ink", () => {
    const svg = buildPageSvg([card], { pageIndex: 0, attempt: 2 });
    expect(svg).toContain("Reference card");
    expect(svg).not.toContain('opacity="0.35"');

    const agentBlock = htmlBlockObject(
      ownerId,
      noteId,
      page0,
      { x: 400, y: 400, width: 100, height: 100 },
      "<p>Hint</p>",
    );
    const geometry = describePage([card, agentBlock], 0, []);
    expect(geometry.ink.bounds).toBeNull();
  });

  it("picks the page: next keeps the original rule, last never joins a question page", () => {
    const facts = {
      lastPageIndex: 2,
      lastPageEmpty: false,
      questionPages: [1, 2],
    };
    expect(planCardPage("next", { ...facts, questionIndex: 0 })).toBe(0);
    expect(planCardPage("next", { ...facts, questionIndex: 2 })).toBe("append");
    expect(planCardPage("new", { ...facts, questionIndex: 0 })).toBe("append");
    expect(planCardPage("last", { ...facts, questionIndex: null })).toBe(2);
    expect(() => planCardPage("last", { ...facts, questionIndex: 2 })).toThrow(
      /already holds a question/,
    );
    expect(
      planCardPage("last", {
        lastPageIndex: 3,
        lastPageEmpty: false,
        questionPages: [1, 2],
        questionIndex: 2,
      }),
    ).toBe(3);
  });

  it("reuses an empty last page for new and next instead of leaving a blank page behind", () => {
    // Reference cards on pages 0 and 1, Q1 on page 2, and an empty page 3 the user added.
    const facts = { lastPageIndex: 3, lastPageEmpty: true, questionPages: [2] };
    expect(planCardPage("new", { ...facts, questionIndex: 1 })).toBe(3);
    expect(planCardPage("next", { ...facts, questionIndex: 1 })).toBe(3);
    expect(planCardPage("new", { ...facts, questionIndex: null })).toBe(3);
    expect(
      planCardPage("new", { ...facts, lastPageEmpty: false, questionIndex: 1 }),
    ).toBe("append");
  });
});
