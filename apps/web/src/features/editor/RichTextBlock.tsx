// Rich-text block surface: Tiptap editor bound to a serialized ProseMirror JSON document. Never exposes editor instances; consumers see serialized JSON only.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { EDITOR_EXTENSIONS } from "./extensions";
import {
  Bold,
  Heading1,
  Italic,
  List,
  Settings2,
  Table as TableIcon,
} from "lucide-react";

export const EMPTY_DOC: Record<string, unknown> = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

export interface RichTextBlockProps {
  /** Serialized ProseMirror JSON document for the block content. */
  content: Record<string, unknown>;
  editable?: boolean;
  /** Focuses the editor when it becomes editable. */
  autoFocus?: boolean;
  /** Emits the serialized ProseMirror JSON after every content update. */
  onChange?: (json: Record<string, unknown>) => void;
  onFocusChange?: (focused: boolean) => void;
}

/** Renders a Tiptap-based rich-text block with optional editing and formatting controls. */
export function RichTextBlock({
  content,
  editable = true,
  autoFocus = false,
  onChange,
  onFocusChange,
}: RichTextBlockProps): ReactNode {
  const [toolbarOpen, setToolbarOpen] = useState(false);
  // Callbacks stay fresh across renders without recreating the editor.
  const onChangeRef = useRef(onChange);
  const onFocusChangeRef = useRef(onFocusChange);
  onChangeRef.current = onChange;
  onFocusChangeRef.current = onFocusChange;

  const lastEmittedRef = useRef<Record<string, unknown> | null>(content);

  const editor = useEditor({
    extensions: EDITOR_EXTENSIONS,
    content: content as never,
    editable,
    onUpdate: ({ editor }) => {
      const json = editor.getJSON() as Record<string, unknown>;
      lastEmittedRef.current = json;
      onChangeRef.current?.(json);
    },
    onFocus: () => {
      onFocusChangeRef.current?.(true);
    },
    onBlur: () => {
      onFocusChangeRef.current?.(false);
    },
  });

  // Apply external content only when it differs from what this block last emitted.
  useEffect(() => {
    if (!editor || content === lastEmittedRef.current) return;
    lastEmittedRef.current = content;
    editor.commands.setContent(content as never, { emitUpdate: false });
  }, [editor, content]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor || !editable || !autoFocus) return;
    const frame = requestAnimationFrame(() => editor.commands.focus("end"));
    return () => cancelAnimationFrame(frame);
  }, [editor, editable, autoFocus]);

  useEffect(() => {
    if (!editable) setToolbarOpen(false);
  }, [editable]);

  if (!editor) return null;

  return (
    <div className="rich-text-block" data-rich-text-block="">
      {editable ? (
        <div
          className="rich-text-toolbar"
          contentEditable={false}
          suppressContentEditableWarning
        >
          <button
            type="button"
            className="rich-text-toolbar-toggle"
            aria-label="Text formatting"
            aria-expanded={toolbarOpen}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setToolbarOpen((current) => !current)}
          >
            <Settings2 size={16} />
          </button>
          {toolbarOpen ? (
            <div className="rich-text-toolbar-controls">
              <button
                type="button"
                aria-label="Bold"
                data-active={editor.isActive("bold") ? "true" : "false"}
                onMouseDown={(event) => {
                  event.preventDefault();
                  editor.chain().focus().toggleBold().run();
                }}
              >
                <Bold size={18} />
              </button>
              <button
                type="button"
                aria-label="Italic"
                data-active={editor.isActive("italic") ? "true" : "false"}
                onMouseDown={(event) => {
                  event.preventDefault();
                  editor.chain().focus().toggleItalic().run();
                }}
              >
                <Italic size={18} />
              </button>
              <button
                type="button"
                aria-label="Heading 1"
                data-active={
                  editor.isActive("heading", { level: 1 }) ? "true" : "false"
                }
                onMouseDown={(event) => {
                  event.preventDefault();
                  editor.chain().focus().toggleHeading({ level: 1 }).run();
                }}
              >
                <Heading1 size={18} />
              </button>
              <button
                type="button"
                aria-label="Bullet list"
                data-active={editor.isActive("bulletList") ? "true" : "false"}
                onMouseDown={(event) => {
                  event.preventDefault();
                  editor.chain().focus().toggleBulletList().run();
                }}
              >
                <List size={18} />
              </button>
              <button
                type="button"
                aria-label="Insert table"
                onMouseDown={(event) => {
                  event.preventDefault();
                  editor
                    .chain()
                    .focus()
                    .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                    .run();
                }}
              >
                <TableIcon size={18} />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <EditorContent
        editor={editor}
        className="rich-text-content"
        data-rich-text-content=""
      />
    </div>
  );
}
