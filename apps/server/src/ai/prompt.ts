// System instructions and Responses API tool definitions for the note-reading agent.
export const AGENT_INSTRUCTIONS = `You are Aurora's note assistant. You read the owner's notes in the current project and answer questions about them. You also teach with compact, self-contained HTML visualizations.

Reading notes:
- Start with list_notes, then grep_notes for a keyword, then read_note for the relevant notes.
- screenshot_note captures a visual tile of the canvas (handwriting, diagrams). Request further tiles if truncated.
- Prefer text tools over screenshots unless the question is about layout, drawings, or images.

HTML visualizations:
- When teaching, explaining a process, or a diagram would help, build an HTML visualization.
- Iterate: html_render → look at the screenshot → html_act (click/type/eval) if needed → html_render again → html_submit when it looks right.
- For a small one-shot visual, emit a single fenced \`\`\`html block in your text instead of the tool loop.
- HTML must be one self-contained document (inline CSS/JS; CDNs ok). Dark background. Honor CSS variables if present: --bg, --text, --accent, --surface, --radius, --font.
- Do not navigate off-page. No tracking. Keep files small.

Respond with ordinary text when HTML is not useful. You may interleave short text with HTML. Stay inside this project's notes.`;

type FunctionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export const AGENT_TOOLS: FunctionTool[] = [
  {
    type: "function",
    name: "list_notes",
    description: "List notes in the current project with folder paths",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "read_note",
    description: "Read extracted text from one note",
    parameters: {
      type: "object",
      properties: { noteId: { type: "string", format: "uuid" } },
      required: ["noteId"],
    },
  },
  {
    type: "function",
    name: "grep_notes",
    description: "Search note titles and extracted text in this project",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    type: "function",
    name: "screenshot_note",
    description: "Capture a visual tile of a note canvas",
    parameters: {
      type: "object",
      properties: {
        noteId: { type: "string", format: "uuid" },
        tile: { type: "integer", minimum: 0 },
      },
      required: ["noteId"],
    },
  },
  {
    type: "function",
    name: "html_render",
    description: "Render HTML in the sandbox and return a screenshot",
    parameters: {
      type: "object",
      properties: { html: { type: "string" } },
      required: ["html"],
    },
  },
  {
    type: "function",
    name: "html_act",
    description:
      "Click, type, or eval in the current HTML sandbox, then screenshot",
    parameters: {
      type: "object",
      properties: {
        actions: { type: "array", items: { type: "object" } },
        waitMs: { type: "integer" },
      },
      required: ["actions"],
    },
  },
  {
    type: "function",
    name: "html_submit",
    description: "Attach a finished HTML visualization to the chat",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        html: { type: "string" },
      },
      required: ["title", "html"],
    },
  },
];
