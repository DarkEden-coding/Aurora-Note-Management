// These Vitest checks validate the shared transport contract: canvas modes, sync
// operation round-trips, regional query responses, library tree summaries, and
// the WebSocket event union — the payloads both Aurora runtimes exchange.
import { describe, expect, it } from "vitest";
import {
  CHAT_MODELS,
  aiToolCallSchema,
  canvasModeSchema,
  chatConversationSchema,
  chatTurnEventSchema,
  drawingPaletteSchema,
  libraryTreeSchema,
  regionalObjectQueryResponseSchema,
  serverEventSchema,
  syncOperationSchema,
} from "./index.js";

const noteId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";
const deviceId = "11111111-1111-4111-8111-111111111111";

describe("drawingPaletteSchema", () => {
  it("defaults to the sole black drawing color", () => {
    expect(drawingPaletteSchema.parse(undefined)).toEqual(["#000000"]);
  });

  it("accepts ordered full CSS hex colors", () => {
    expect(
      drawingPaletteSchema.parse(["#000000", "#Ab12ef", "#FFFFFF"]),
    ).toEqual(["#000000", "#Ab12ef", "#FFFFFF"]);
  });

  it("rejects shorthand, invalid, duplicate, empty, and oversized palettes", () => {
    expect(drawingPaletteSchema.safeParse(["#fff"]).success).toBe(false);
    expect(drawingPaletteSchema.safeParse(["#gg0000"]).success).toBe(false);
    expect(drawingPaletteSchema.safeParse(["#ABCDEF", "#abcdef"]).success).toBe(
      false,
    );
    expect(drawingPaletteSchema.safeParse([]).success).toBe(false);
    expect(
      drawingPaletteSchema.safeParse(
        Array.from({ length: 65 }, () => "#000000"),
      ).success,
    ).toBe(false);
  });
});

describe("canvasModeSchema", () => {
  it("accepts all four canvas modes", () => {
    for (const mode of ["infinite", "fixed-width", "fixed-height", "paged"]) {
      expect(canvasModeSchema.safeParse(mode).success).toBe(true);
    }
  });

  it("rejects unknown modes", () => {
    expect(canvasModeSchema.safeParse("grid").success).toBe(false);
  });
});

describe("syncOperationSchema", () => {
  it("accepts a complete upsert operation", () => {
    const result = syncOperationSchema.safeParse({
      id: "44444444-4444-4444-8444-444444444444",
      deviceId,
      noteId,
      objectId,
      baseRevision: 0,
      clientTimestamp: new Date().toISOString(),
      mutation: {
        type: "upsert",
        object: {
          id: objectId,
          ownerId: "55555555-5555-4555-8555-555555555555",
          noteId,
          pageId: null,
          kind: "sticky-note",
          bounds: { x: 0, y: 0, width: 100, height: 100 },
          rotation: 0,
          zIndex: 0,
          locked: false,
          groupId: null,
          payload: { text: "hello" },
          revision: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a delete operation with a non-UUID device id", () => {
    const result = syncOperationSchema.safeParse({
      id: "44444444-4444-4444-8444-444444444444",
      deviceId: "not-a-uuid",
      noteId,
      objectId,
      baseRevision: 1,
      clientTimestamp: new Date().toISOString(),
      mutation: { type: "delete" },
    });
    expect(result.success).toBe(false);
  });
});

describe("regionalObjectQueryResponseSchema", () => {
  it("accepts an empty regional read", () => {
    expect(
      regionalObjectQueryResponseSchema.safeParse({
        objects: [],
        truncated: false,
        serverTimestamp: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });

  it("requires the truncated flag so clients can re-request", () => {
    expect(
      regionalObjectQueryResponseSchema.safeParse({
        objects: [],
        serverTimestamp: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});

describe("libraryTreeSchema", () => {
  it("accepts a minimal flattened tree", () => {
    const result = libraryTreeSchema.safeParse({
      projects: [
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "P", order: 0 },
      ],
      folders: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          parentId: null,
          name: "F",
        },
      ],
      notes: [
        {
          id: noteId,
          projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          folderId: null,
          title: "N",
          kind: "canvas",
          canvasMode: "infinite",
          favorite: false,
          trashed: false,
          archived: false,
          revision: 0,
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("serverEventSchema", () => {
  it("accepts objects-changed broadcasts", () => {
    expect(
      serverEventSchema.safeParse({
        type: "objects-changed",
        noteId,
        objects: [],
        deletedObjectIds: [],
        originOperationId: "op-1",
        serverTimestamp: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });

  it("accepts note-changed broadcasts and rejects unknown kinds", () => {
    expect(
      serverEventSchema.safeParse({
        type: "note-changed",
        noteId,
        originOperationId: "op-1",
        serverTimestamp: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(
      serverEventSchema.safeParse({
        type: "library-changed",
        serverTimestamp: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(
      serverEventSchema.safeParse({
        type: "ack",
        noteId,
        serverTimestamp: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});

describe("aiToolCallSchema", () => {
  it("accepts list_notes with empty arguments", () => {
    expect(
      aiToolCallSchema.safeParse({ name: "list_notes", arguments: {} }).success,
    ).toBe(true);
  });

  it("accepts html_act click and type actions", () => {
    expect(
      aiToolCallSchema.safeParse({
        name: "html_act",
        arguments: {
          actions: [
            { click: "#go" },
            { type: { selector: "input", text: "hi" } },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects screenshot_note without a uuid", () => {
    expect(
      aiToolCallSchema.safeParse({
        name: "screenshot_note",
        arguments: { noteId: "nope" },
      }).success,
    ).toBe(false);
  });
});

describe("chatConversationSchema", () => {
  it("publishes the requested model names and their reasoning levels", () => {
    expect(
      CHAT_MODELS.map(({ id, label, reasoningLevels }) => ({
        id,
        label,
        reasoningLevels: [...reasoningLevels],
      })),
    ).toEqual(
      [
        ["gpt-5.6-sol", "Sol"],
        ["gpt-5.6-terra", "Terra"],
        ["gpt-5.6-luna", "Luna"],
        ["gpt-6-astra", "Astra"],
      ].map(([id, label]) => ({
        id,
        label,
        reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
      })),
    );
  });

  it("accepts supported model settings and rejects unknown ones", () => {
    const conversation = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      title: "Chat",
      model: "gpt-5.6-terra",
      reasoning: "medium",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(chatConversationSchema.safeParse(conversation).success).toBe(true);
    expect(
      chatConversationSchema.safeParse({ ...conversation, model: "unknown" })
        .success,
    ).toBe(false);
    expect(
      chatConversationSchema.safeParse({ ...conversation, reasoning: "off" })
        .success,
    ).toBe(false);
  });
});

describe("chatTurnEventSchema", () => {
  it("accepts a text-delta event", () => {
    expect(
      chatTurnEventSchema.safeParse({ type: "text-delta", delta: "Hi" })
        .success,
    ).toBe(true);
  });
});
