import { describe, expect, it } from "vitest";
import { makeCanvasObject } from "./objects";
import { reconcileObject } from "./reconcileObject";

const object = makeCanvasObject({
  id: "00000000-0000-4000-8000-00000000c001",
  ownerId: "00000000-0000-4000-8000-00000000a001",
  noteId: "00000000-0000-4000-8000-00000000b001",
  kind: "rich-text",
  bounds: { x: 0, y: 0, width: 200, height: 100 },
  zIndex: 0,
  payload: { doc: { type: "doc", content: [{ type: "paragraph" }] } },
});

describe("live draft reconciliation", () => {
  it("preserves rapid backspaces through older acknowledgements, then accepts the latest save", () => {
    const draft = { ...object, payload: { doc: { text: "he" } } };
    const older = {
      ...object,
      revision: 2,
      payload: { doc: { text: "hello" } },
    };
    const result = reconcileObject(draft, older, draft);
    expect(result.object.payload).toEqual(draft.payload);
    expect(result.object.revision).toBe(2);
    expect(result.acknowledged).toBe(false);
    const saved = reconcileObject(
      result.object,
      { ...draft, revision: 3 },
      draft,
    );
    expect(saved.acknowledged).toBe(true);
    expect(saved.object.payload).toEqual(draft.payload);
  });
  it("accepts remote undo when no local draft is pending and rejects stale revisions", () => {
    const remote = { ...object, revision: 5 };
    expect(reconcileObject(object, remote, undefined).object).toBe(remote);
    expect(reconcileObject(remote, object, undefined).object).toBe(remote);
  });
});

it("recognizes acknowledgements after JSONB reorders nested document keys", () => {
  const local = {
    ...object,
    payload: {
      doc: {
        type: "doc",
        content: [
          { type: "paragraph", attrs: { align: "left", color: "red" } },
        ],
      },
    },
  };
  const remote = {
    ...object,
    revision: 2,
    payload: {
      doc: {
        content: [
          { attrs: { color: "red", align: "left" }, type: "paragraph" },
        ],
        type: "doc",
      },
    },
  };
  expect(reconcileObject(local, remote, local).acknowledged).toBe(true);
});
