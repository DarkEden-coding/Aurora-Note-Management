// Defines the practice MCP server: instructions for Claude and every practice_* tool with its input schema.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { practiceOptionsSchema } from "@aurora/shared";
import { resolveOwnerId } from "../account/owner.js";
import { markSchema } from "./marks.js";
import { CARD_WIDTH, PAGE_HEIGHT, PAGE_WIDTH } from "./page.js";
import { practiceHtmlTemplate } from "./template.js";
import {
  finishSession,
  getSession,
  gradeQuestion,
  postQuestion,
  renderSubmission,
  setStatus,
  startSession,
  waitForEvent,
} from "./service.js";

const DEFAULT_WAIT_SECONDS = 240;
const MAX_WAIT_SECONDS = 540;

const HTML_RULES = `Card HTML: plain HTML + inline CSS only (no <script>, no event handlers, no external URLs; data: images are fine). Math: $...$ inline, $$...$$ display (also \\(...\\), \\[...\\]), rendered with KaTeX. Cards are ${CARD_WIDTH}px wide on a dark background (#23262d, text #e6e8ec, 18px/1.5 system-ui); use class "muted" for secondary text.`;

const INSTRUCTIONS = `Aurora guided practice: you run a handwritten practice session. Each question is a card on its own page of a practice note; the user writes the answer with a pen and presses Done; you receive an image of the page, grade it, and draw red marks on their work.

Checklist:
1. practice_start with the options the user asked for. Tell the user the note title (Aurora > project "Practice").
2. Write the question HTML. When layout matters, preview it with practice_html_template (+ html_preview at ${PAGE_WIDTH}px). Then practice_post_question with a height that fits the content.
3. practice_wait until event "submitted" (on "timeout", just call it again).
4. Look at the image and call practice_grade with points and marks.
5. practice_wait again: "next" -> post the next question (adapt difficulty to performance); "retry" -> wait for the next "submitted".
6. After the last question's "next", practice_finish with a summary card.
If the chat was interrupted, practice_get_session recovers the current state.

Coordinates: every x/y you send or see is page-relative: origin at the page's top-left, page is ${PAGE_WIDTH} x ${PAGE_HEIGHT} units, y grows downward. The submission image is drawn at 1.5x with a faint grid every 50 units, labelled every 100 units; read positions off the grid labels, not image pixels. The question card sits at (32, 32), ${CARD_WIDTH} wide; the user's writing is below/around it.

${HTML_RULES}`;

const sessionId = z
  .string()
  .uuid()
  .describe("Practice session id from practice_start");
const questionId = z
  .string()
  .uuid()
  .describe("Question id from practice_post_question");
const cardHeight = z
  .number()
  .min(40)
  .max(PAGE_HEIGHT - 64)
  .describe("Card height in page units; size it to fit the content");
const placedCardSchema = z
  .object({
    html: z.string().min(1).max(200_000),
    x: z.number().min(0).max(PAGE_WIDTH),
    y: z.number().min(0).max(PAGE_HEIGHT),
    width: z.number().min(40).max(PAGE_WIDTH),
    height: z.number().min(20).max(PAGE_HEIGHT),
  })
  .describe(`Card placed in page-relative coordinates. ${HTML_RULES}`);

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const ownerId = resolveOwnerId;

export function buildPracticeMcpServer(appUrl: string): McpServer {
  const server = new McpServer(
    { name: "aurora-practice", version: "1.0.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "practice_html_template",
    {
      description: `Returns a standalone HTML document (Aurora's card CSS + KaTeX from CDN) for previewing a card at the page width before sending it. Pass html to embed it, or omit it to get the wrapper with a placeholder comment. ${HTML_RULES}`,
      inputSchema: {
        html: z
          .string()
          .max(200_000)
          .optional()
          .describe("Card body HTML to embed"),
      },
    },
    async ({ html }) => ({
      content: [{ type: "text", text: practiceHtmlTemplate(html) }],
    }),
  );

  server.registerTool(
    "practice_start",
    {
      description:
        'Starts a session: creates (or reuses) the Aurora project "Practice" and a new paged note titled `title`. Returns { sessionId, noteId, noteTitle, appUrl, session }. options toggles feedback (inkMarks, card, solution, retry) and header progress (bar, runningScore, mastery, status); omitted fields use defaults.',
      inputSchema: {
        title: z.string().min(1).max(200).describe("Session and note title"),
        totalQuestions: z.number().int().min(1).max(50),
        options: practiceOptionsSchema.optional(),
      },
    },
    async ({ title, totalQuestions, options }) => {
      const session = await startSession(await ownerId(), {
        title,
        totalQuestions,
        options: options ?? practiceOptionsSchema.parse({}),
      });
      return json({
        sessionId: session.id,
        noteId: session.noteId,
        noteTitle: session.title,
        appUrl,
        session,
      });
    },
  );

  server.registerTool(
    "practice_post_question",
    {
      description: `Posts the next question as a prompt card at page (32, 32), width ${CARD_WIDTH}, on the next page. Allowed only when every earlier question is closed (after its "next" event). Returns { questionId, session }. ${HTML_RULES}`,
      inputSchema: {
        sessionId,
        html: z.string().min(1).max(200_000).describe("Question card HTML"),
        height: cardHeight,
        maxPoints: z.number().positive().max(1000),
        topics: z
          .array(z.string().min(1).max(80))
          .max(10)
          .describe("Topic tags used for per-topic mastery"),
      },
    },
    async (input) => json(await postQuestion(await ownerId(), input)),
  );

  server.registerTool(
    "practice_wait",
    {
      description: `Blocks until the user acts, then consumes that event. "submitted": text metadata { event, questionId, index, attempt, maxPoints, topics, pageSize } plus the page PNG; grade it with practice_grade. "next": the user moved on (post the next question or finish). "retry": the user is re-answering; wait for the next "submitted". { event: "timeout" } means nothing happened yet; call again.`,
      inputSchema: {
        sessionId,
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(MAX_WAIT_SECONDS)
          .default(DEFAULT_WAIT_SECONDS),
      },
    },
    async ({ sessionId, timeoutSeconds }, extra) => {
      const result = await waitForEvent(
        await ownerId(),
        sessionId,
        timeoutSeconds * 1000,
        extra.signal,
      );
      if (result.event !== "submitted") return json(result);
      const { png, ...meta } = result;
      return {
        content: [
          { type: "text", text: JSON.stringify(meta, null, 2) },
          {
            type: "image",
            data: png.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    },
  );

  server.registerTool(
    "practice_get_submission",
    {
      description:
        "Re-renders a question's page as a PNG (same format as practice_wait) without consuming any event.",
      inputSchema: { questionId },
    },
    async ({ questionId }) => {
      const { meta, png } = await renderSubmission(await ownerId(), questionId);
      return {
        content: [
          { type: "text", text: JSON.stringify(meta, null, 2) },
          {
            type: "image",
            data: png.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    },
  );

  server.registerTool(
    "practice_grade",
    {
      description:
        "Grades a submitted question. Replaces any earlier attempt's marks/cards on that page with the new ones and sets the question to graded. points counts toward the score only on attempt 1. All coordinates are page-relative (816x1056). Marks are drawn in red: circle/box {x,y,width,height} (top-left + size); underline/strike/arrow {x1,y1,x2,y2}; check/cross {x,y,size?=28} centred on (x,y); path {points:[[x,y],...]}; text {x,y,text,width?=220} (top-left). feedback/solution cards only when enabled in the session options. statusText sets the header status line (cleared when omitted).",
      inputSchema: {
        questionId,
        points: z.number().min(0).max(1000),
        marks: z.array(markSchema).max(200).default([]),
        feedback: placedCardSchema.optional(),
        solution: placedCardSchema
          .optional()
          .describe("Worked solution card; starts collapsed for the user"),
        statusText: z.string().max(200).optional(),
      },
    },
    async (input) => json(await gradeQuestion(await ownerId(), input)),
  );

  server.registerTool(
    "practice_set_status",
    {
      description:
        "Sets (or clears with null) the status line in the practice header, e.g. 'Preparing question 3…'. Visible when progress.status is enabled.",
      inputSchema: { sessionId, text: z.string().max(200).nullable() },
    },
    async ({ sessionId, text }) =>
      json(await setStatus(await ownerId(), sessionId, text)),
  );

  server.registerTool(
    "practice_finish",
    {
      description: `Places the summary card at (32, 32) on the page after the last question and marks the session complete. Requires no question awaiting work or grading. ${HTML_RULES}`,
      inputSchema: {
        sessionId,
        summaryHtml: z.string().min(1).max(200_000),
        height: cardHeight,
      },
    },
    async (input) => json(await finishSession(await ownerId(), input)),
  );

  server.registerTool(
    "practice_get_session",
    {
      description:
        "Returns a session's state (questions with state, attempt, points). Without sessionId, returns the most recently active session. Use it to resume after an interrupted chat.",
      inputSchema: { sessionId: sessionId.optional() },
    },
    async ({ sessionId }) => json(await getSession(await ownerId(), sessionId)),
  );

  return server;
}
