// Rich-text block surface: Tiptap editor bound to a serialized ProseMirror JSON document. Never exposes editor instances; consumers see serialized JSON only.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { fitText } from "./fitText";
import { EDITOR_EXTENSIONS } from "./extensions";
import {
  Bold,
  Heading1,
  Italic,
  List,
  Settings2,
  Table as TableIcon,
} from "lucide-react";

export interface RichTextBlockProps {
  /** Serialized ProseMirror JSON document for the block content. */
  content: Record<string, unknown>;
  editable?: boolean;
  /** Focuses the editor when it becomes editable. */
  autoFocus?: boolean;
  color?: string;
  /** Emits the serialized ProseMirror JSON after every content update. */
  onChange?: (json: Record<string, unknown>) => void;
  onFocusChange?: (focused: boolean) => void;
}

/** Renders a Tiptap-based rich-text block with optional editing and formatting controls. */
export function RichTextBlock({
  content,
  editable = true,
  autoFocus = false,
  color,
  onChange,
  onFocusChange,
}: RichTextBlockProps): ReactNode {
  const [toolbarOpen, setToolbarOpen] = useState(false);
  // Callbacks stay fresh across renders without recreating the editor.
  const onChangeRef = useRef(onChange);
  const onFocusChangeRef = useRef(onFocusChange);
  onChangeRef.current = onChange;
  onFocusChangeRef.current = onFocusChange;

  const blockRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: EDITOR_EXTENSIONS,
    content: content as never,
    editable,
    onUpdate: ({ editor }) => {
      const json = editor.getJSON() as Record<string, unknown>;
      onChangeRef.current?.(json);
    },
    onFocus: () => {
      onFocusChangeRef.current?.(true);
    },
    onBlur: () => {
      onFocusChangeRef.current?.(false);
    },
  });

  // Compare document values: persistence returns fresh JSON objects for save echoes.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const doc = editor.schema.nodeFromJSON(content);
    if (!editor.state.doc.eq(doc)) {
      editor.commands.setContent(content as never, { emitUpdate: false });
    }
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
    const block = blockRef.current;
    if (!editor || !block) return;
    let frame = 0;
    let disposed = false;
    const update = () => {
      if (disposed) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const surface = block.querySelector<HTMLElement>(".ProseMirror");
        if (surface && !editor.isDestroyed && !editor.view.composing) {
          fitText(block, surface, editor.isEmpty);
        }
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(block);
    editor.on("update", update);
    editor.on("transaction", update);
    update();
    void document.fonts?.ready.then(update);
    return () => {
      disposed = true;
      observer.disconnect();
      editor.off("update", update);
      editor.off("transaction", update);
      cancelAnimationFrame(frame);
    };
  }, [editor]);

  useEffect(() => {
    if (!editable) setToolbarOpen(false);
  }, [editable]);

  if (!editor) return null;

  return (
    <div
      ref={blockRef}
      className="rich-text-block"
      data-rich-text-block=""
      {...(color ? { style: { color } } : {})}
    >
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
