// Defines Aurora's MCP server: instructions for Claude, every practice_* tool with its input schema, and the notes_* library tools.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { practiceGradingSchema, practiceOptionsSchema } from "@aurora/shared";
import { resolveOwnerId } from "../account/owner.js";
import { markSchema } from "./marks.js";
import { CARD_WIDTH, PAGE_HEIGHT, PAGE_WIDTH } from "./page.js";
import { practiceHtmlTemplate } from "./template.js";
import { listLocations } from "./location.js";
import {
  finishSession,
  getSession,
  gradeQuestion,
  listSessions,
  postQuestion,
  previewGrade,
  renderSubmission,
  setGrading,
  setStatus,
  startSession,
  waitForEvent,
} from "./service.js";
import { DEFAULT_IMAGE_OPTIONS, type PageImage } from "./submission.js";
import { NOTES_INSTRUCTIONS, registerNoteTools } from "../agent/mcp-tools.js";

// Many MCP clients abort a request after 60 s, so the default wait stays under that; clients
// that allow long tool calls can ask for up to the server's configured maximum.
const DEFAULT_WAIT_SECONDS = 50;
// With a progress token, practice_wait streams a progress notification this often as a keepalive.
const KEEPALIVE_MS = 15_000;

const HTML_RULES = `Card HTML: plain HTML + inline CSS only (no <script>, no event handlers, no external URLs; data: images are fine). Math: $...$ inline, $$...$$ display (also \\(...\\), \\[...\\]), rendered with KaTeX. Cards are ${CARD_WIDTH}px wide on a dark background (#23262d, text #e6e8ec, 18px/1.5 system-ui); use class "muted" for secondary text. Labelled elements: give each multiple-choice option data-option="A" (B, C, ...) and any other part you want located data-region="name"; add <div class="final-answer"></div> (a dashed, empty box labelled "Final answer"; set a height with style if 96px is too small) for the user to write the final answer in. The submission returns each labelled element's page bounds in regions, draws them on the image, and adds a close-up image of the final-answer box. Include the box and options in the card height.`;

const SUBMISSION_FIELDS = `Submission metadata (practice_wait "submitted", practice_get_submission, practice_grade dryRun), all page-relative: card = question card bounds; regions = [{ kind: "option" | "finalAnswer" | "region", label, x, y, width, height, text? }] measured in the user's browser on Done (empty for older app versions), also drawn as dashed blue labelled boxes on the image; ink = { bounds, clusters[] } of the user's writing; freeRegions = empty rectangles near the work, good spots for text marks or a feedback card; grading = the session's grading policy; image = { x, y, width, height, scale } the page area the first image shows; finalAnswerImage = the area of the second image (close-up of the final-answer box), when there is one.`;

const IMAGE_OPTIONS_DOC = `image options: crop "page" (default, whole page) or "ink" (only the user's writing, card regions and this question's marks plus padding, snapped to the 50-unit grid; grid labels stay in page units); scale = pixels per page unit (default 1.5; 1 or 0.75 saves context).`;

const INSTRUCTIONS = `Aurora guided practice: you run a handwritten practice session. Each question is a card on its own page of a practice note; the user writes the answer with a pen and presses Done; you receive an image of the page, grade it, and draw red marks on their work.

Checklist:
1. Decide where the note goes. If the user has not named a project (and optional folder), call practice_list_locations, ask the user where to put it (offer the existing places), and wait for the answer before starting. Then practice_start with that location and the options the user asked for, and tell the user where the note is.
2. Write the question HTML. When layout matters, preview it with practice_html_template (+ html_preview at ${PAGE_WIDTH}px). Then practice_post_question with a height that fits the content.
3. practice_wait until event "submitted" (on "timeout", just call it again). Waiting is cheap: if your MCP client allows long tool calls, pass timeoutSeconds up to the server maximum (see the tool) instead of re-calling every 50 s; send a progressToken to get keepalive progress notifications every 15 s.
4. Look at the image and call practice_grade with points and marks. Apply the session's grading policy (returned as grading). To check placement first, call practice_grade with dryRun: true. If a mark lands badly, call practice_grade again: it replaces the question's marks until the user presses Next or Retry.
5. practice_wait again: "next" -> post the next question (adapt difficulty to performance); "retry" -> wait for the next "submitted".
6. After the last question's "next", practice_finish with a summary card.
If the chat was interrupted, practice_get_session recovers the current state.

Coordinates: every x/y you send or see is page-relative: origin at the page's top-left, page is ${PAGE_WIDTH} x ${PAGE_HEIGHT} units, y grows downward. The submission image is drawn at 1.5x by default with a faint grid every 50 units, labelled every 100 units; read positions off the grid labels, not image pixels. The question card sits at (32, 32), ${CARD_WIDTH} wide, drawn as a grey box with its labelled elements outlined; the user's writing is below/around it (and may be on it, e.g. a circled option). Place marks with the returned ink bounds/clusters and freeRegions rather than guessing.

${SUBMISSION_FIELDS}

Context: over a long session, pass image { crop: "ink", scale: 1 } to practice_wait and practice_get_submission for smaller images.

${HTML_RULES}

${NOTES_INSTRUCTIONS}`;

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

const imageOptions = z
  .object({
    crop: z.enum(["page", "ink"]).default(DEFAULT_IMAGE_OPTIONS.crop),
    scale: z.number().min(0.5).max(3).default(DEFAULT_IMAGE_OPTIONS.scale),
    padding: z
      .number()
      .min(0)
      .max(200)
      .default(DEFAULT_IMAGE_OPTIONS.padding)
      .describe('Page units around the content when crop is "ink"'),
  })
  .optional()
  .describe(IMAGE_OPTIONS_DOC);

const gradingPolicy = practiceGradingSchema.describe(
  'Session grading policy returned with every submission: leniency "strict" | "standard" (default) | "lenient" (generous partial credit for correct method), and an optional free-text rubric (e.g. "full marks if the derivative is right even with arithmetic slips").',
);

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function submissionContent(meta: object, images: PageImage[]): CallToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(meta, null, 2) },
      ...images.map((image) => ({
        type: "image" as const,
        data: image.png.toString("base64"),
        mimeType: "image/png",
      })),
    ],
  };
}

const ownerId = resolveOwnerId;

export function buildPracticeMcpServer(
  appUrl: string,
  maxWaitSeconds: number,
): McpServer {
  const server = new McpServer(
    { name: "aurora-practice", version: "1.2.0" },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "practice_html_template",
    {
      description: `Returns a standalone HTML document (Aurora's card CSS + KaTeX from CDN) for previewing a card at the page width before sending it. Pass html to embed it, or omit it to get the wrapper with a placeholder comment. The .final-answer class is included. Example multiple-choice card: <p>Which is $f'(x)$ for $f(x)=x^3$?</p><p data-option="A">A. $3x^2$</p><p data-option="B">B. $x^2$</p><div class="final-answer" style="height:80px"></div>. ${HTML_RULES}`,
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
    "practice_list_locations",
    {
      description:
        "Lists the user's projects and their folder paths, so you can offer them when asking where a new practice note should go.",
      inputSchema: {},
    },
    async () => json(await listLocations(await ownerId())),
  );

  server.registerTool(
    "practice_start",
    {
      description:
        "Starts a session: creates a new paged note titled `title` in the chosen project and folder (missing ones are created; names match case-insensitively). Ask the user for the location first if they have not given one. Returns { sessionId, noteId, noteTitle, appUrl, session }. options toggles feedback (inkMarks, card, solution, retry) and the progress bar below the canvas (bar, runningScore, mastery, status); omitted fields use defaults. grading (optional) sets the session grading policy; it is returned by practice_get_session and with every submission, and practice_set_grading changes it later.",
      inputSchema: {
        title: z.string().min(1).max(200).describe("Session and note title"),
        totalQuestions: z.number().int().min(1).max(50),
        project: z
          .string()
          .min(1)
          .max(200)
          .describe("Project name the user chose"),
        folder: z
          .string()
          .max(500)
          .optional()
          .describe(
            'Folder path inside the project, e.g. "Calculus/Derivatives"',
          ),
        options: practiceOptionsSchema.optional(),
        grading: gradingPolicy.optional(),
      },
    },
    async ({ title, totalQuestions, project, folder, options, grading }) => {
      const session = await startSession(await ownerId(), {
        title,
        totalQuestions,
        options: options ?? practiceOptionsSchema.parse({}),
        grading: grading ?? null,
        location: { project, folder },
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
      description: `Blocks until the user acts, then consumes that event. "submitted": text metadata { event, questionId, index, attempt, maxPoints, topics, pageSize, grading, card, regions, ink, freeRegions, image, finalAnswerImage? } plus the page PNG (and a final-answer close-up when the card has a .final-answer box); grade it with practice_grade. "next": the user moved on (post the next question or finish). "retry": the user is re-answering; wait for the next "submitted". { event: "timeout" } means nothing happened yet; call again. timeoutSeconds defaults to ${DEFAULT_WAIT_SECONDS} (safe for clients that abort after 60 s) and may be up to ${maxWaitSeconds} when your client allows long tool calls. If the request carries a progressToken, the server answers as an SSE stream and sends a progress notification every ${KEEPALIVE_MS / 1000} s while waiting, so clients that reset their timeout on progress can wait the full time. ${IMAGE_OPTIONS_DOC}`,
      inputSchema: {
        sessionId,
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(maxWaitSeconds)
          .default(DEFAULT_WAIT_SECONDS),
        image: imageOptions,
      },
    },
    async ({ sessionId, timeoutSeconds, image }, extra) => {
      const progressToken = extra._meta?.progressToken;
      const started = Date.now();
      const keepalive =
        progressToken === undefined
          ? null
          : setInterval(() => {
              extra
                .sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: Math.round((Date.now() - started) / 1000),
                    total: timeoutSeconds,
                    message: "Waiting for the user",
                  },
                })
                .catch(() => undefined);
            }, KEEPALIVE_MS);
      try {
        const result = await waitForEvent(
          await ownerId(),
          sessionId,
          timeoutSeconds * 1000,
          image ?? DEFAULT_IMAGE_OPTIONS,
          extra.signal,
        );
        if (result.event !== "submitted") return json(result);
        const { images, ...meta } = result;
        return submissionContent(meta, images);
      } finally {
        if (keepalive) clearInterval(keepalive);
      }
    },
  );

  server.registerTool(
    "practice_get_submission",
    {
      description: `Re-renders a question's page (same metadata and images as practice_wait "submitted") without consuming any event; after grading it shows your marks. ${IMAGE_OPTIONS_DOC}`,
      inputSchema: { questionId, image: imageOptions },
    },
    async ({ questionId, image }) => {
      const { meta, images } = await renderSubmission(
        await ownerId(),
        questionId,
        image ?? DEFAULT_IMAGE_OPTIONS,
      );
      return submissionContent(meta, images);
    },
  );

  server.registerTool(
    "practice_grade",
    {
      description: `Grades a submitted question, or re-grades one that is already graded (allowed until the user presses Next or Retry): replaces that question's earlier marks/cards on the page with the new ones and sets it to graded. points counts toward the score only on attempt 1 (a re-grade of attempt 1 corrects it). dryRun: true saves nothing and returns the page image with the proposed marks (same metadata as a submission) so you can check placement first. All coordinates are page-relative (816x1056); use the submission's ink and freeRegions to avoid covering the user's writing. Marks are drawn in red: circle/box {x,y,width,height} (top-left + size); underline/strike/arrow {x1,y1,x2,y2}; check/cross {x,y,size?=28} centred on (x,y); path {points:[[x,y],...]}; text {x,y,text,width?=220} (top-left). feedback/solution cards only when enabled in the session options. statusText sets the header status line (cleared when omitted). Follow the session's grading policy (practice_get_session or the submission's grading). ${IMAGE_OPTIONS_DOC} (dryRun only)`,
      inputSchema: {
        questionId,
        points: z.number().min(0).max(1000),
        marks: z.array(markSchema).max(200).default([]),
        feedback: placedCardSchema.optional(),
        solution: placedCardSchema
          .optional()
          .describe("Worked solution card; starts collapsed for the user"),
        statusText: z.string().max(200).optional(),
        dryRun: z
          .boolean()
          .default(false)
          .describe(
            "Preview only: return the page image with these marks; nothing is saved",
          ),
        image: imageOptions,
      },
    },
    async ({ dryRun, image, ...input }) => {
      if (!dryRun) return json(await gradeQuestion(await ownerId(), input));
      const { meta, images } = await previewGrade(
        await ownerId(),
        input,
        image ?? DEFAULT_IMAGE_OPTIONS,
      );
      return submissionContent({ dryRun: true, ...meta }, images);
    },
  );

  server.registerTool(
    "practice_set_grading",
    {
      description:
        "Sets (or clears with null) the session grading policy, e.g. when the user asks for more lenient marking. Returned by practice_get_session and with every later submission. To apply it to a question that is still graded, re-grade it with practice_grade.",
      inputSchema: { sessionId, grading: gradingPolicy.nullable() },
    },
    async ({ sessionId, grading }) =>
      json(await setGrading(await ownerId(), sessionId, grading)),
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
        "Returns a session's state (questions with state, attempt, points; options; grading policy), for any session including completed ones (ids from practice_list_sessions). Without sessionId, returns the most recently active session. Use it to resume after an interrupted chat. To see a question's submitted work and your marks, call practice_get_submission with its id.",
      inputSchema: { sessionId: sessionId.optional() },
    },
    async ({ sessionId }) => json(await getSession(await ownerId(), sessionId)),
  );

  server.registerTool(
    "practice_list_sessions",
    {
      description:
        "Lists the user's practice sessions, newest activity first: id, title, noteId, status, questions posted/graded, and score (first-attempt points over graded questions' maxPoints). Read one with practice_get_session, its pages with practice_get_submission or notes_read.",
      inputSchema: {
        status: z.enum(["active", "complete"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async (filters) => json(await listSessions(await ownerId(), filters)),
  );

  registerNoteTools(server);

  return server;
}
