// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RichTextBlock } from "./RichTextBlock";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps selection and undo history through cloned save echoes and rapid backspace", async () => {
  let content: Record<string, unknown> = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "hello world" }] },
    ],
  };
  const render = () =>
    root.render(
      createElement(RichTextBlock, {
        content: structuredClone(content),
        onChange: (doc) => {
          content = doc;
          render();
        },
      }),
    );
  await act(async () => render());
  const surface = container.querySelector(".tiptap") as HTMLElement & {
    editor: Editor;
  };
  const editor = surface.editor;
  await act(async () => {
    editor.commands.setTextSelection(6);
  });
  const originalDoc = editor.state.doc;
  await act(async () => render());
  expect(editor.state.doc).toBe(originalDoc);
  expect(editor.state.selection.from).toBe(6);
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      // Browser backspace produces this deletion transaction. jsdom has no native editing.
      const position = editor.state.selection.from;
      editor.commands.deleteRange({ from: position - 1, to: position });
    });
    await act(async () => render());
  }
  expect(editor.getText()).toBe("h world");
  expect(editor.state.selection.from).toBe(2);
  await act(async () => {
    editor.commands.undo();
  });
  expect(editor.getText()).toBe("hello world");
});
