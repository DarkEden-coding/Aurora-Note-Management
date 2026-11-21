// Registers the notes_* MCP tools: read the user's whole library (notes, typed text, handwriting images) and make additive edits.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { canvasModeSchema } from "@aurora/shared";
import { resolveOwnerId } from "../account/owner.js";
import { markSchema } from "../practice/marks.js";
import { PAGE_HEIGHT, PAGE_WIDTH } from "../practice/page.js";
import {
  annotatePage,
  appendPage,
  createNoteForAgent,
  listNotesForAgent,
  readNote,
  renameNote,
  searchNotes,
} from "./notes.js";

export const NOTES_INSTRUCTIONS = `Library access: notes_list, notes_search and notes_read let you read everything the user has written, not just practice sessions. Every note is read as pages of ${PAGE_WIDTH} x ${PAGE_HEIGHT} units with the same page-relative coordinates and grid as practice images. Paged notes use their real pages; infinite and fixed canvases are cut into page-sized tiles that hold content (each page's origin gives its world position). notes_read returns each page's typed text (rich text, sticky notes, cards) as text plus PNG images of the pages, handwriting included; handwriting is only in the images, so read it there. Search matches titles and typed text, not handwriting. practice_list_sessions lists every past practice session; practice_get_session and practice_get_submission read any of them. Edits are additive only (nothing is ever deleted): notes_create, notes_rename, notes_add_page, and notes_annotate (red marks, red comments and typed text on a page; use dryRun first to check placement). Only edit when the user asks you to.`;

const noteId = z
  .string()
  .uuid()
  .describe("Note id from notes_list or notes_search");
const imageScale = z
  .number()
  .min(0.5)
  .max(3)
  .default(1)
  .describe("Pixels per page unit for page images (1 = 816 x 1056 px)");

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function withImages(meta: unknown, images: Buffer[]): CallToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(meta, null, 2) },
      ...images.map((png) => ({
        type: "image" as const,
        data: png.toString("base64"),
        mimeType: "image/png",
      })),
    ],
  };
}

const ownerId = resolveOwnerId;

export function registerNoteTools(server: McpServer): void {
  server.registerTool(
    "notes_list",
    {
      description:
        "Lists the user's notes, most recently updated first, with title, project, folder path, canvas mode and created/updated times. Filter by project name and optionally a folder path inside it (case-insensitive; a folder lists only the notes directly in it). practice_list_locations shows the available projects and folders.",
      inputSchema: {
        project: z.string().min(1).max(200).optional(),
        folder: z
          .string()
          .max(500)
          .optional()
          .describe('Folder path inside the project, e.g. "Practice Tests"'),
        archived: z
          .boolean()
          .default(false)
          .describe("List archived notes instead of active ones"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
    },
    async (input) => json(await listNotesForAgent(await ownerId(), input)),
  );

  server.registerTool(
    "notes_search",
    {
      description:
        "Case-insensitive substring search over note titles and typed text (rich-text boxes, sticky notes, practice cards). Handwriting is not searchable; browse with notes_list and read it with notes_read. Returns notes with location and up to 5 matching snippets each; trashed notes are excluded.",
      inputSchema: {
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ query, limit }) =>
      json(await searchNotes(await ownerId(), query, limit)),
  );

  server.registerTool(
    "notes_read",
    {
      description: `Reads a note: metadata, every page's typed text with page-relative bounds (author "agent" marks your own earlier marks/cards), and PNG images of the requested pages showing everything on them, handwriting included, on the same coordinate grid as practice images (${PAGE_WIDTH} x ${PAGE_HEIGHT} page units, labels every 100). pages defaults to the first 3; request others by index (max 8 per call). For a practice note, practiceSessionId and each page's practiceQuestionId link to the practice tools.`,
      inputSchema: {
        noteId,
        pages: z
          .array(z.number().int().min(0))
          .max(8)
          .optional()
          .describe("Page indexes to render as images; [] for text only"),
        scale: imageScale,
      },
    },
    async ({ noteId, pages, scale }) => {
      const { meta, images } = await readNote(await ownerId(), noteId, {
        pages,
        image: { scale },
      });
      return withImages(meta, images);
    },
  );

  server.registerTool(
    "notes_create",
    {
      description:
        "Creates an empty note titled `title` in the named project and folder path (missing ones are created; names match case-insensitively). Ask the user where it goes if they have not said. canvasMode defaults to paged (816 x 1056 pages).",
      inputSchema: {
        title: z.string().min(1).max(200),
        project: z.string().min(1).max(200),
        folder: z.string().max(500).optional(),
        canvasMode: canvasModeSchema.default("paged"),
      },
    },
    async (input) => json(await createNoteForAgent(await ownerId(), input)),
  );

  server.registerTool(
    "notes_rename",
    {
      description: "Renames a note.",
      inputSchema: { noteId, title: z.string().min(1).max(200) },
    },
    async ({ noteId, title }) =>
      json(await renameNote(await ownerId(), noteId, title)),
  );

  server.registerTool(
    "notes_add_page",
    {
      description:
        "Appends an empty page at the end of a paged note. Returns { pageIndex, pageCount }.",
      inputSchema: { noteId },
    },
    async ({ noteId }) => json(await appendPage(await ownerId(), noteId)),
  );

  server.registerTool(
    "notes_annotate",
    {
      description: `Adds to one page of a note (page index as returned by notes_read), in page-relative coordinates: red marks and comments, using the same mark shapes as practice_grade (circle/box {x,y,width,height}; underline/strike/arrow {x1,y1,x2,y2}; check/cross {x,y,size?}; path {points}; text {x,y,text,width?} for a short red comment), and typed text boxes ({x,y,width,height?,text}, plain text, one paragraph per line). Nothing existing is changed or removed; the user can move or delete what you add. dryRun: true saves nothing. Returns the new object ids and the page image with the additions.`,
      inputSchema: {
        noteId,
        pageIndex: z.number().int().min(0),
        marks: z.array(markSchema).max(200).default([]),
        texts: z
          .array(
            z.object({
              x: z.number().min(0).max(PAGE_WIDTH),
              y: z.number().min(0).max(PAGE_HEIGHT),
              width: z.number().min(40).max(PAGE_WIDTH),
              height: z.number().min(20).max(PAGE_HEIGHT).optional(),
              text: z.string().min(1).max(10_000),
            }),
          )
          .max(20)
          .default([]),
        dryRun: z.boolean().default(false),
        scale: imageScale,
      },
    },
    async ({ scale, ...input }) => {
      const { meta, image } = await annotatePage(await ownerId(), {
        ...input,
        image: { scale },
      });
      return withImages(meta, [image]);
    },
  );
}
