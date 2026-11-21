// The Android app's renderer page: draws one practice card or rich-text block with the web app's
// own code and styles, then tells the app (window.AuroraRender.done) so it can snapshot the page.
// Built into the Android assets by vite.native.config.ts (npm run build:native).
import "../styles/tokens.css";
import "katex/dist/katex.min.css";
import "../features/editor/editorStyles.css";
import "../features/practice/practice.css";
import { Editor } from "@tiptap/core";
import { EDITOR_EXTENSIONS } from "../features/editor/extensions";
import { fitText } from "../features/editor/fitText";
import { cardVariant, mountCard } from "../features/practice/mountCard";

declare global {
  interface Window {
    renderObject: (
      token: number,
      kind: string,
      payload: Record<string, unknown>,
      width: number,
      height: number,
      zoom: number,
    ) => void;
    AuroraRender?: { done(token: number): void };
  }
}

let editor: Editor | null = null;

function practiceCard(frame: HTMLElement, payload: Record<string, unknown>) {
  const variant = cardVariant(payload);
  if (variant === "solution") {
    // Solutions start collapsed behind their toggle, as on the web.
    const wrap = document.createElement("div");
    wrap.className = "practice-solution";
    const toggle = document.createElement("button");
    toggle.className = "practice-solution-toggle";
    toggle.textContent = "Show solution";
    wrap.append(toggle);
    frame.append(wrap);
    return;
  }
  const host = document.createElement("div");
  host.className = "practice-card-host";
  frame.append(host);
  mountCard(
    host,
    variant,
    typeof payload.html === "string" ? payload.html : "",
  );
}

function richText(frame: HTMLElement, payload: Record<string, unknown>) {
  const block = document.createElement("div");
  block.className = "rich-text-block";
  if (typeof payload.color === "string") block.style.color = payload.color;
  const content = document.createElement("div");
  content.className = "rich-text-content";
  block.append(content);
  frame.append(block);
  const doc = payload.doc ?? { type: "doc", content: [] };
  editor = new Editor({
    element: content,
    extensions: EDITOR_EXTENSIONS,
    content: doc as never,
    editable: false,
  });
  const surface = content.querySelector<HTMLElement>(".ProseMirror");
  if (surface) fitText(block, surface, editor.isEmpty);
}

/** The colour the app looks for to know the page now shows render `token`. */
function markerColor(token: number): string {
  return `rgb(${token & 255}, ${(token >> 8) & 255}, 128)`;
}

window.renderObject = (token, kind, payload, width, height, zoom) => {
  const frame = document.getElementById("frame")!;
  frame.style.zoom = String(zoom);
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  editor?.destroy();
  editor = null;
  frame.replaceChildren();
  if (kind === "practice-card") practiceCard(frame, payload);
  else if (kind === "rich-text") richText(frame, payload);
  // Painted in the same update as the content, so a matching pixel means the snapshot is current.
  document.getElementById("marker")!.style.background = markerColor(token);
  void document.fonts.ready.then(() =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => window.AuroraRender?.done(token)),
    ),
  );
};
