// Unit tests for Tiptap text extraction, HTML fence splitting, and JWT expiry parsing.
import { describe, expect, it } from "vitest";
import { extractDocText, splitAssistantText } from "../src/ai/noteText.js";
import { jwtExpiryMs, parseJwtClaims } from "../src/ai/oauth.js";

describe("extractDocText", () => {
  it("walks paragraphs, headings, and table rows", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", content: [{ type: "text", text: "Title" }] },
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "text", text: "A" }] },
                { type: "tableCell", content: [{ type: "text", text: "B" }] },
              ],
            },
          ],
        },
      ],
    };
    expect(extractDocText(doc)).toBe("Title\nHello\nA | B");
  });
});

describe("splitAssistantText", () => {
  it("splits fenced html from surrounding text", () => {
    const parts = splitAssistantText(
      "Intro\n```html\n<div>x</div>\n```\nOutro",
    );
    expect(parts).toEqual([
      { type: "text", text: "Intro" },
      { type: "html", title: "Visualization 1", html: "<div>x</div>" },
      { type: "text", text: "Outro" },
    ]);
  });
});

describe("jwtExpiryMs", () => {
  it("reads exp from a JWT payload", () => {
    const payload = Buffer.from(
      JSON.stringify({ exp: 1_700_000_000, email: "a@b.c" }),
    ).toString("base64url");
    const token = `hdr.${payload}.sig`;
    expect(jwtExpiryMs(token)).toBe(1_700_000_000 * 1000);
    expect(parseJwtClaims(token)?.email).toBe("a@b.c");
  });
});
