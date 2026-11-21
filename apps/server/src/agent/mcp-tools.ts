// Registers the notes_* MCP tools: read the user's whole library (notes, objects, handwriting images), add to it, and edit or delete objects by id.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { canvasModeSchema, textStyleSchema } from "@aurora/shared";
import { resolveOwnerId } from "../account/owner.js";
import { markSchema } from "../practice/marks.js";
import { PAGE_HEIGHT, PAGE_WIDTH } from "../practice/page.js";
import { objectEditSchema, objectStyleSchema } from "./objects.js";
import {
  deleteObjects,
  editObjects,
  getObjects,
  restyleNote,
} from "./edits.js";
import {
  annotatePage,
  appendPage,
  createNoteForAgent,
  listNotesForAgent,
  readNote,
  renameNote,
  searchNotes,
} from "./notes.js";

const FONT_LIST = textStyleSchema.shape.fontFamily
  .unwrap()
  .options.map((font) => (font === "sans" ? "sans (default)" : font))
  .join(", ");

export const NOTES_INSTRUCTIONS = `Library access: notes_list, notes_search and notes_read let you read everything the user has written, not just practice sessions. Every note is read as pages of ${PAGE_WIDTH} x ${PAGE_HEIGHT} units with the same page-relative coordinates and grid as practice images. Paged notes use their real pages; infinite and fixed canvases are cut into page-sized tiles that hold content (each page's origin gives its world position). notes_read returns each page's objects (id, kind, author, page-relative bounds, current style, typed text) plus PNG images of the pages showing everything on them (handwriting, imported PDF pages, pictures); handwriting is only in the images, so read it there (its strokes are counted, and listed with includeInk or notes_get_objects). Search matches titles and typed text, not handwriting. practice_list_sessions lists every past practice session; practice_get_session and practice_get_submission read any of them.
Editing: notes_create, notes_rename, notes_add_page and notes_annotate add things (marks, comments and typed text boxes, with optional font and color). notes_edit_objects moves, resizes, retexts or restyles objects by id; notes_restyle sets one style on all text and/or agent marks of a note; notes_delete_objects deletes objects by explicit id only (it saves a restore snapshot first). Fonts: ${FONT_LIST}; any six-digit hex color. Use dryRun first, never delete or change the user's own handwriting or text unless the user asked for that, and only edit when the user asks you to.`;

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

export function registerNoteTools(server: McpServer, uploadDir: string): void {
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
      description: `Reads a note: metadata, every page's objects (id, kind, author "user" or "agent" for your own marks/cards, page-relative x/y/width/height, style {fontFamily, fontSize, fontWeight, fontStyle, color} for text or {color, strokeWidth} for drawn objects, and text) with each page's inkStrokeCount, and PNG images of the requested pages showing everything on them, handwriting included, on the same coordinate grid as practice images (${PAGE_WIDTH} x ${PAGE_HEIGHT} page units, labels every 100). pages defaults to the first 3; request others by index (max 8 per call). For a practice note, practiceSessionId and each page's practiceQuestionId link to the practice tools.`,
      inputSchema: {
        noteId,
        pages: z
          .array(z.number().int().min(0))
          .max(8)
          .optional()
          .describe("Page indexes to render as images; [] for text only"),
        includeInk: z
          .boolean()
          .default(false)
          .describe(
            "Also list the user's handwriting strokes as objects (ids and bounds)",
          ),
        scale: imageScale,
      },
    },
    async ({ noteId, pages, includeInk, scale }) => {
      const { meta, images } = await readNote(await ownerId(), noteId, {
        pages,
        includeInk,
        image: { scale, uploadDir },
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
      description: `Adds to one page of a note (page index as returned by notes_read), in page-relative coordinates: marks and comments, using the same mark shapes as practice_grade (circle/box {x,y,width,height}; underline/strike/arrow {x1,y1,x2,y2}; check/cross {x,y,size?}; path {points}; each optionally {color, strokeWidth}, default red 3; text {x,y,text,width?} for a short comment, red 20px sans-serif by default), and typed text boxes ({x,y,width,height?,text}, plain text, one paragraph per line; 18px sans-serif by default; height defaults to fit the text). Text marks and text boxes take fontFamily (${FONT_LIST}), fontSize (8-96; a text box's text shrinks below it to fit the box), fontWeight (normal/bold), fontStyle (normal/italic) and color (#rrggbb). Nothing existing is changed; change or remove additions later with notes_edit_objects or notes_delete_objects. dryRun: true saves nothing. Returns the new object ids and the page image with the additions.`,
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
              ...textStyleSchema.shape,
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
        image: { scale, uploadDir },
      });
      return withImages(meta, [image]);
    },
  );

  server.registerTool(
    "notes_get_objects",
    {
      description:
        'Details of objects in a note, in page-relative coordinates: pass ids (from notes_read), or pageIndex for everything on that page, the user\'s handwriting strokes included. Each object has id, kind (variant for practice cards; a text mark is a practice-card with variant "label"), author, locked, pageIndex, x/y/width/height, style and text.',
      inputSchema: {
        noteId,
        ids: z.array(z.string().uuid()).min(1).max(500).optional(),
        pageIndex: z.number().int().min(0).optional(),
      },
    },
    async (input) => json(await getObjects(await ownerId(), input)),
  );

  server.registerTool(
    "notes_edit_objects",
    {
      description: `Edits existing objects by id (any author). Each edit changes only what it gives: x/y (page-relative; pageIndex moves it to another page), width/height (resizes; ink and lines scale with it), text (rich-text box, sticky note or text mark; replaced as plain paragraphs, so formatting inside a rich-text box is lost), and style: fontFamily (${FONT_LIST}), fontSize (8-96), fontWeight, fontStyle and color for text boxes and text marks; color and strokeWidth for ink, lines, arrows, boxes and ellipses. A style field an object cannot take is an error. Changes the user's own objects only when the user asked. dryRun: true checks the edits and returns the result without saving. Returns the edited objects and images of their pages.`,
      inputSchema: {
        noteId,
        edits: z.array(objectEditSchema).min(1).max(100),
        dryRun: z.boolean().default(false),
        scale: imageScale,
      },
    },
    async ({ scale, ...input }) => {
      const { meta, images } = await editObjects(await ownerId(), {
        ...input,
        image: { scale, uploadDir },
      });
      return withImages(meta, images);
    },
  );

  server.registerTool(
    "notes_restyle",
    {
      description: `Sets one style on many objects of a note in one call. targets: "text" = rich-text boxes and text marks, "marks" = your marks (ink, lines, arrows, boxes, ellipses you or practice grading drew); the user's handwriting and shapes are never touched. author "agent" (default) restyles only your own text; "any" also restyles the user's typed text (only when the user asked; a restore snapshot is saved first). Each object takes the fields that apply to it: fontFamily (${FONT_LIST}), fontSize, fontWeight, fontStyle, color, strokeWidth. dryRun: true returns the ids that would change.`,
      inputSchema: {
        noteId,
        style: objectStyleSchema,
        targets: z
          .array(z.enum(["text", "marks"]))
          .min(1)
          .default(["text"]),
        author: z.enum(["agent", "any"]).default("agent"),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => json(await restyleNote(await ownerId(), input)),
  );

  server.registerTool(
    "notes_delete_objects",
    {
      description:
        "Deletes objects from a note by explicit id only (ids from notes_read or notes_get_objects; there is no filter or delete-all). Never pass the user's handwriting or text unless the user asked for exactly that. Run with dryRun: true first to see what would go. Before deleting it saves a snapshot of the note (restore point, kept 30 days) and returns its snapshotId. Every id must belong to the note, or nothing is deleted.",
      inputSchema: {
        noteId,
        ids: z.array(z.string().uuid()).min(1).max(200),
        dryRun: z.boolean().default(false),
      },
    },
    async (input) => json(await deleteObjects(await ownerId(), input)),
  );
}
