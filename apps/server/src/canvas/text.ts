// Plain text of typed canvas objects (rich-text Tiptap docs, sticky notes, practice cards) for search, agent reads and server renders.
import type { CanvasObject } from "@aurora/shared";

// Tiptap nodes that end a line of text.
const BLOCK_NODES = new Set([
  "paragraph",
  "heading",
  "listItem",
  "codeBlock",
  "blockquote",
  "tableRow",
  "horizontalRule",
]);

type DocNode = {
  type?: unknown;
  text?: unknown;
  content?: unknown;
};

function docText(node: DocNode): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "hardBreak") return "\n";
  const children = Array.isArray(node.content)
    ? (node.content as DocNode[])
    : [];
  const separator = node.type === "tableRow" ? " | " : "";
  const inner = children.map(docText).join(separator);
  return typeof node.type === "string" && BLOCK_NODES.has(node.type)
    ? `${inner}\n`
    : inner;
}

/** Recovers readable text from stored card or label HTML (tags dropped, <br> and blocks become newlines). */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The typed text an object carries, or null for ink, shapes, images and other non-text objects. */
export function objectText(object: CanvasObject): string | null {
  const payload = object.payload;
  switch (object.kind) {
    case "rich-text": {
      const doc = payload.doc;
      if (!doc || typeof doc !== "object") return null;
      return docText(doc as DocNode)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    case "sticky-note":
      return typeof payload.text === "string" ? payload.text : null;
    case "practice-card":
      return typeof payload.html === "string" ? htmlToText(payload.html) : null;
    default:
      return null;
  }
}

/** A minimal Tiptap doc: one paragraph per line, as the web editor stores typed text. */
export function textToDoc(text: string): Record<string, unknown> {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
}
