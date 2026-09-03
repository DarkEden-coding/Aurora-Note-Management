// Deterministic demo content so CanvasWorkspace is visibly functional when objects are omitted. Demo objects use the payload conventions documented in objects.ts.
import type { CanvasObject } from "@aurora/shared";
import { EMPTY_DOC } from "../editor";
import { DEMO_OWNER_ID } from "./pageLayout";
import { makeCanvasObject, setStrokePayload } from "./objects";

const DEMO_OBJECT_IDS = [
  "00000000-0000-4000-8000-000000000101",
  "00000000-0000-4000-8000-000000000102",
  "00000000-0000-4000-8000-000000000103",
  "00000000-0000-4000-8000-000000000104",
  "00000000-0000-4000-8000-000000000105",
  "00000000-0000-4000-8000-000000000106",
  "00000000-0000-4000-8000-000000000107",
  "00000000-0000-4000-8000-000000000108",
  "00000000-0000-4000-8000-000000000109",
  "00000000-0000-4000-8000-000000000110",
] as const;

const DEMO_IMAGE_SRC =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">' +
      '<rect width="240" height="160" fill="#2a2f3a"/>' +
      '<g fill="#78a0ff"><rect x="20" y="100" width="28" height="40"/>' +
      '<rect x="60" y="70" width="28" height="70"/><rect x="100" y="40" width="28" height="100"/>' +
      '<rect x="140" y="60" width="28" height="80"/><rect x="180" y="20" width="28" height="120"/></g>' +
      "</svg>",
  );

const DEMO_DOC: Record<string, unknown> = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "Kickoff notes" }],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Welcome to the Aurora canvas — select, draw, and pan around this demo.",
        },
      ],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Rich-text blocks with tables" }],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Pressure strokes and shapes" }],
            },
          ],
        },
      ],
    },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: (["Task", "Owner", "Status"] as const).map((text) => ({
            type: "tableHeader",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          })),
        },
        {
          type: "tableRow",
          content: (["Editor", "shell", "done"] as const).map((text) => ({
            type: "tableCell",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          })),
        },
        {
          type: "tableRow",
          content: (["Sync", "runtime", "next"] as const).map((text) => ({
            type: "tableCell",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          })),
        },
      ],
    },
  ],
};

/** Pressure sweep for the demo stroke: sine path with varying pressure. */
function demoStrokePoints(): Array<[number, number, number]> {
  const points: Array<[number, number, number]> = [];
  const count = 48;
  for (let i = 0; i <= count; i += 1) {
    const t = i / count;
    points.push([
      t * 240,
      60 + Math.sin(t * Math.PI * 2) * 50,
      0.35 + 0.6 * Math.abs(Math.sin(t * Math.PI * 3)),
    ]);
  }
  return points;
}

function demoStrokeObject(
  noteId: string,
  ownerId: string,
  id: string,
  zIndex: number,
): CanvasObject {
  const points: Array<[number, number, number]> = demoStrokePoints();
  return makeCanvasObject({
    id,
    ownerId,
    noteId,
    kind: "stroke",
    bounds: { x: 480, y: 80, width: 240, height: 112 },
    zIndex,
    payload: setStrokePayload(
      points.map(([x, y, pressure]) => ({ x, y, pressure })),
      "#78a0ff",
      2.5,
    ),
  });
}

/** Builds the demo object set for a note; every object carries the demo owner id. */
export function buildDemoObjects(
  noteId: string,
  ownerId: string = DEMO_OWNER_ID,
): CanvasObject[] {
  const [
    richTextId,
    strokeId,
    rectId,
    ellipseId,
    lineId,
    arrowId,
    stickyId,
    imageId,
    attachmentId,
    pdfRefId,
  ] = DEMO_OBJECT_IDS;
  const objects: CanvasObject[] = [];
  let zIndex = 1;

  objects.push(
    makeCanvasObject({
      id: richTextId,
      ownerId,
      noteId,
      kind: "rich-text",
      bounds: { x: 48, y: 64, width: 380, height: 420 },
      zIndex: zIndex++,
      payload: { doc: DEMO_DOC },
    }),
    demoStrokeObject(noteId, ownerId, strokeId, zIndex++),
    makeCanvasObject({
      id: rectId,
      ownerId,
      noteId,
      kind: "rectangle",
      bounds: { x: 480, y: 260, width: 160, height: 100 },
      zIndex: zIndex++,
      payload: {
        color: "#e6e8ec",
        fill: "rgba(120, 160, 255, 0.18)",
        strokeWidth: 2,
      },
    }),
    makeCanvasObject({
      id: ellipseId,
      ownerId,
      noteId,
      kind: "ellipse",
      bounds: { x: 700, y: 260, width: 140, height: 100 },
      zIndex: zIndex++,
      payload: {
        color: "#e6e8ec",
        fill: "rgba(246, 189, 96, 0.18)",
        strokeWidth: 2,
      },
    }),
    makeCanvasObject({
      id: lineId,
      ownerId,
      noteId,
      kind: "line",
      bounds: { x: 480, y: 430, width: 200, height: 8 },
      zIndex: zIndex++,
      payload: { color: "#e6e8ec", strokeWidth: 2 },
    }),
    makeCanvasObject({
      id: arrowId,
      ownerId,
      noteId,
      kind: "arrow",
      bounds: { x: 740, y: 420, width: 120, height: 60 },
      zIndex: zIndex++,
      payload: { color: "#e6e8ec", strokeWidth: 2 },
    }),
    makeCanvasObject({
      id: stickyId,
      ownerId,
      noteId,
      kind: "sticky-note",
      bounds: { x: 48, y: 540, width: 190, height: 190 },
      zIndex: zIndex++,
      payload: {
        text: "Ideas\n\n— try the pen tool\n— pinch to zoom",
        color: "#f7d774",
      },
    }),
    makeCanvasObject({
      id: imageId,
      ownerId,
      noteId,
      kind: "image",
      bounds: { x: 300, y: 560, width: 240, height: 160 },
      zIndex: zIndex++,
      payload: { src: DEMO_IMAGE_SRC, alt: "demo chart" },
    }),
    makeCanvasObject({
      id: attachmentId,
      ownerId,
      noteId,
      kind: "attachment",
      bounds: { x: 60, y: 780, width: 220, height: 64 },
      zIndex: zIndex++,
      payload: {
        name: "kickoff-report.pdf",
        size: 148_576,
        fileId: "00000000-0000-4000-8000-000000000201",
      },
    }),
    makeCanvasObject({
      id: pdfRefId,
      ownerId,
      noteId,
      kind: "pdf-page-reference",
      bounds: { x: 560, y: 520, width: 260, height: 200 },
      zIndex: zIndex++,
      payload: { sourceNoteId: noteId, pageNumber: 1 },
    }),
  );
  return objects;
}

/** Empty document helper re-exported for demo consumers. */
export { EMPTY_DOC };
