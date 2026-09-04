// Defines the lightweight serialized document defaults shared without loading Tiptap.
export const EMPTY_DOC: Record<string, unknown> = {
  type: "doc",
  content: [{ type: "paragraph" }],
};
