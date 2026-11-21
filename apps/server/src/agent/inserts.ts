// Agent inserts beyond marks and text: pictures (stored as uploads) and free-form HTML blocks, placed anywhere on any page of any note.
import { z } from "zod";
import type { Bounds, CanvasObject } from "@aurora/shared";
import { PAGE_HEIGHT, PAGE_WIDTH, checkFitsPage } from "../practice/page.js";
import { decodeAgentImage, storeAgentImage } from "./images.js";
import { addToPage, agentObject, type PageImageOptions } from "./notes.js";
import type { NotePage } from "./pages.js";

// Page-relative placement shared by the insert tools.
export const placementShape = {
  x: z.number().min(0).max(PAGE_WIDTH).describe("Left edge"),
  y: z.number().min(0).max(PAGE_HEIGHT).describe("Top edge"),
  width: z.number().min(4).max(PAGE_WIDTH),
  height: z.number().min(4).max(PAGE_HEIGHT),
};

/** An unlocked HTML card the user can move, resize or delete like any object. */
export function htmlBlockObject(
  ownerId: string,
  noteId: string,
  page: NotePage,
  bounds: Bounds,
  html: string,
): CanvasObject {
  checkFitsPage(bounds);
  return agentObject(ownerId, noteId, page, "practice-card", bounds, {
    variant: "html",
    html,
  });
}

/** An image object showing an uploaded file, in the payload shape the web app writes. */
export function imageObject(
  ownerId: string,
  noteId: string,
  page: NotePage,
  bounds: Bounds,
  fileId: string,
  alt: string,
): CanvasObject {
  checkFitsPage(bounds);
  return agentObject(ownerId, noteId, page, "image", bounds, { fileId, alt });
}

type Placement = {
  noteId: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  image: PageImageOptions;
};

/** Just the page-relative bounds of a placement (the object stores nothing else from it). */
function boundsOf({ x, y, width, height }: Placement): Bounds {
  return { x, y, width, height };
}

export async function insertHtml(
  ownerId: string,
  { html, ...input }: Placement & { html: string },
) {
  const bounds = boundsOf(input);
  const { meta, image } = await addToPage(
    ownerId,
    { ...input, dryRun: false },
    (page) => [htmlBlockObject(ownerId, input.noteId, page, bounds, html)],
  );
  return { meta: { ...meta, objectId: meta.objectIds[0] }, image };
}

export async function insertImage(
  ownerId: string,
  uploadDir: string,
  {
    data,
    alt,
    ...input
  }: Placement & { data: string; alt?: string | undefined },
) {
  const bounds = boundsOf(input);
  // Check the box and the data before anything is stored.
  checkFitsPage(bounds);
  const decoded = decodeAgentImage(data, bounds.width);
  const fileId = await storeAgentImage(ownerId, uploadDir, decoded);
  const { meta, image } = await addToPage(
    ownerId,
    { ...input, dryRun: false },
    (page) => [
      imageObject(ownerId, input.noteId, page, bounds, fileId, alt ?? "image"),
    ],
  );
  return {
    meta: { ...meta, objectId: meta.objectIds[0], fileId },
    image,
  };
}
