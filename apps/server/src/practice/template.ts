// Practice card base stylesheet and the standalone HTML preview document (KaTeX from CDN) returned to Claude.
import { PRACTICE_CARD_CSS } from "@aurora/shared";
import { PAGE_WIDTH } from "./page.js";

const KATEX = "https://cdn.jsdelivr.net/npm/katex@0.16.47/dist";
const CARD_PLACEHOLDER = "<!-- card html goes here -->";

/** Full HTML document that previews one card at the page width the canvas uses. */
export function practiceHtmlTemplate(cardHtml?: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Aurora practice card preview</title>
<link rel="stylesheet" href="${KATEX}/katex.min.css">
<script defer src="${KATEX}/katex.min.js"></script>
<script defer src="${KATEX}/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body, {delimiters: [
    {left: '$$', right: '$$', display: true},
    {left: '\\\\[', right: '\\\\]', display: true},
    {left: '$', right: '$', display: false},
    {left: '\\\\(', right: '\\\\)', display: false}
  ]})"></script>
<style>
html, body { margin: 0; background: #1b1d21; }
body { width: ${PAGE_WIDTH}px; padding: 32px; box-sizing: border-box; }
${PRACTICE_CARD_CSS}
.card { height: auto; }
</style>
</head>
<body>
<div class="card" data-variant="prompt">
${cardHtml ?? CARD_PLACEHOLDER}
</div>
</body>
</html>
`;
}
