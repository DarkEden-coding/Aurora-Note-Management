// Base stylesheet for practice cards, shared so the web card renderer and the MCP preview template render identically.
// Selectors target a `.card` element with a `data-variant` attribute; the web app scopes them inside a shadow root.
export const PRACTICE_CARD_CSS = `
.card {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  overflow: hidden;
  padding: 20px 24px;
  border-radius: 12px;
  background: #23262d;
  color: #e6e8ec;
  font:
    18px/1.5 system-ui,
    -apple-system,
    "Segoe UI",
    sans-serif;
}

.card > :first-child {
  margin-top: 0;
}

.card > :last-child {
  margin-bottom: 0;
}

h1,
h2,
h3 {
  margin: 0 0 0.5em;
  line-height: 1.25;
  font-weight: 650;
}

h1 {
  font-size: 1.4em;
}

h2 {
  font-size: 1.22em;
}

h3 {
  font-size: 1.08em;
}

p,
ul,
ol {
  margin: 0 0 0.6em;
}

code,
pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.88em;
  background: #1b1d21;
  border-radius: 6px;
}

code {
  padding: 0.1em 0.35em;
}

pre {
  margin: 0 0 0.6em;
  padding: 10px 12px;
  white-space: pre-wrap;
}

pre code {
  padding: 0;
  font-size: 1em;
  background: none;
}

table {
  border-collapse: collapse;
  margin: 0 0 0.6em;
}

th,
td {
  border: 1px solid #3a3f4a;
  padding: 4px 10px;
  text-align: left;
}

img,
svg {
  max-width: 100%;
}

.muted {
  color: #9aa0aa;
}

/* Empty box the user writes their final answer in; Claude gets its region (and a crop) with the submission. */
.final-answer {
  position: relative;
  box-sizing: border-box;
  min-height: 96px;
  margin: 0.8em 0 0;
  border: 2px dashed #5b6475;
  border-radius: 10px;
}

.final-answer::before {
  content: "Final answer";
  position: absolute;
  top: 4px;
  left: 10px;
  color: #9aa0aa;
  font-size: 13px;
  line-height: 1;
}

.card[data-variant="feedback"] {
  border-left: 4px solid rgba(255, 92, 92, 0.65);
}

/* Free-form HTML blocks (agent inserts and practice reference cards): the HTML brings its own background and spacing. */
.card[data-variant="html"] {
  padding: 0;
  border-radius: 0;
  background: transparent;
}

.card[data-variant="label"] {
  overflow: visible;
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: #ff5c5c;
  font:
    20px/1.25 "Comic Neue",
    "Segoe Print",
    "Bradley Hand",
    cursive;
}
`;
