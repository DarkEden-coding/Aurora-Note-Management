import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MarkdownText } from "./MarkdownText.js";

it("renders assistant Markdown, GFM, and math without executing HTML", () => {
  const html = renderToStaticMarkup(
    createElement(
      MarkdownText,
      null,
      `## Method\n\n**Use** $x^2$.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>alert(1)</script>`,
    ),
  );

  expect(html).toContain("<h2>Method</h2>");
  expect(html).toContain("<strong>Use</strong>");
  expect(html).toContain('class="katex"');
  expect(html).toContain("<table>");
  expect(html).not.toContain("<script>");
});
