// Turns Claude-authored practice card HTML into safe DOM: DOMPurify sanitizing (no scripts, handlers, embeds, or external URLs; data: images allowed) followed by KaTeX rendering of $…$, $$…$$, \(…\), and \[…\] outside code.
import DOMPurify, { type Config, type DOMPurify as Purifier } from "dompurify";
import katex from "katex";

export type MathSegment =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string; display: boolean };

const isSpace = (char: string | undefined): boolean =>
  char !== undefined && /\s/.test(char);

/** Index of an unescaped `token` at or after `from`, or -1. */
function findClosing(input: string, token: string, from: number): number {
  for (let at = input.indexOf(token, from); at !== -1;) {
    if (input[at - 1] !== "\\") return at;
    at = input.indexOf(token, at + 1);
  }
  return -1;
}

/**
 * Closing `$` for inline math opened just before `from`. Like Pandoc, the
 * content must not start or end with whitespace and the closing `$` must not
 * precede a digit, so prices such as "$5 and $10" stay plain text.
 */
function findInlineClose(input: string, from: number): number {
  if (from >= input.length || isSpace(input[from])) return -1;
  for (let at = findClosing(input, "$", from); at !== -1;) {
    if (
      at > from &&
      !isSpace(input[at - 1]) &&
      !/[0-9]/.test(input[at + 1] ?? "")
    ) {
      return at;
    }
    at = findClosing(input, "$", at + 1);
  }
  return -1;
}

/** Split text into plain and math segments; `\$` becomes a literal dollar sign. */
export function splitMath(input: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let text = "";
  const pushMath = (tex: string, display: boolean): void => {
    if (text !== "") segments.push({ kind: "text", text });
    text = "";
    segments.push({ kind: "math", tex, display });
  };

  let i = 0;
  while (i < input.length) {
    const char = input[i]!;
    const next = input[i + 1];
    if (char === "\\" && next === "$") {
      text += "$";
      i += 2;
      continue;
    }
    if (char === "\\" && (next === "(" || next === "[")) {
      const end = input.indexOf(next === "(" ? "\\)" : "\\]", i + 2);
      if (end !== -1) {
        pushMath(input.slice(i + 2, end), next === "[");
        i = end + 2;
        continue;
      }
    }
    if (char === "$" && next === "$") {
      const end = findClosing(input, "$$", i + 2);
      if (end > i + 2) {
        pushMath(input.slice(i + 2, end), true);
        i = end + 2;
        continue;
      }
      text += "$$";
      i += 2;
      continue;
    }
    if (char === "$") {
      const end = findInlineClose(input, i + 1);
      if (end !== -1) {
        pushMath(input.slice(i + 1, end), false);
        i = end + 1;
        continue;
      }
    }
    text += char;
    i += 1;
  }
  if (text !== "") segments.push({ kind: "text", text });
  return segments;
}

// ---- Sanitizing ------------------------------------------------------------

const SANITIZE_CONFIG: Config = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
  ADD_TAGS: ["style"],
  FORBID_TAGS: [
    "script",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    "link",
    "meta",
    "base",
    "audio",
    "video",
    "source",
    "track",
    "foreignObject",
    "animate",
    "animateMotion",
    "animateTransform",
    "set",
  ],
  // Keep leading <style> elements in the body instead of letting the parser hoist them away.
  FORCE_BODY: true,
};

const URL_ATTRIBUTES = [
  "href",
  "xlink:href",
  "src",
  "srcset",
  "action",
  "formaction",
  "poster",
  "background",
  "ping",
  "cite",
  "longdesc",
];

const isDataImage = (value: string): boolean =>
  /^data:image\//i.test(value.trim());

/** Allow only data: images and in-document fragment references. */
function isAllowedUrl(name: string, value: string): boolean {
  if (name === "src") return isDataImage(value);
  if (name === "href" || name === "xlink:href") {
    return value.trim().startsWith("#") || isDataImage(value);
  }
  return false;
}

/** Remove CSS that can fetch external resources: @import, non-data url(), image-set(). */
export function stripExternalCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(
      /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
      (match, _quote, target: string) =>
        isDataImage(target) || target.trim().startsWith("#") ? match : "none",
    )
    .replace(/(-webkit-)?image-set\(/gi, "blocked(");
}

let purifier: Purifier | null = null;

function getPurifier(): Purifier {
  if (purifier !== null) return purifier;
  const instance = DOMPurify(window);
  instance.addHook("afterSanitizeElements", (node) => {
    if (node.nodeName === "STYLE" && node.textContent) {
      node.textContent = stripExternalCss(node.textContent);
    }
  });
  instance.addHook("afterSanitizeAttributes", (node) => {
    for (const name of URL_ATTRIBUTES) {
      const value = node.getAttribute(name);
      if (value !== null && !isAllowedUrl(name, value)) {
        node.removeAttribute(name);
      }
    }
    const style = node.getAttribute("style");
    if (style !== null) node.setAttribute("style", stripExternalCss(style));
  });
  purifier = instance;
  return instance;
}

// ---- Math rendering ----------------------------------------------------------

const NO_MATH_INSIDE =
  "code, pre, kbd, samp, style, textarea, svg, math, .katex";

/** Replace math delimiters in text nodes with KaTeX markup, leaving code untouched. */
function renderMath(root: DocumentFragment): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!/[$\\]/.test(text.data)) continue;
    if (text.parentElement?.closest(NO_MATH_INSIDE)) continue;
    targets.push(text);
  }
  for (const text of targets) {
    const segments = splitMath(text.data);
    if (
      segments.length === 1 &&
      segments[0]!.kind === "text" &&
      segments[0]!.text === text.data
    ) {
      continue;
    }
    const replacement = doc.createDocumentFragment();
    for (const segment of segments) {
      if (segment.kind === "text") {
        replacement.append(segment.text);
        continue;
      }
      const markup = doc.createElement("template");
      markup.innerHTML = katex.renderToString(segment.tex, {
        displayMode: segment.display,
        throwOnError: false,
      });
      replacement.append(markup.content);
    }
    text.replaceWith(replacement);
  }
}

/** Sanitized, math-rendered card content ready to append into a shadow root. */
export function buildCardContent(html: string): DocumentFragment {
  const clean = getPurifier().sanitize(html, SANITIZE_CONFIG);
  const template = document.createElement("template");
  template.innerHTML = clean;
  renderMath(template.content);
  return template.content;
}
