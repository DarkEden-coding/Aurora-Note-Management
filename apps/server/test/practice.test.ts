// Pure checks for guided practice: mark conversion, page rendering, state transitions, and the wait loop.
import { describe, expect, it } from "vitest";
import { practiceOptionsSchema, type CanvasObject } from "@aurora/shared";
import { markToObjects, practiceTagOf } from "../src/practice/marks.js";
import {
  buildPageSvg,
  inkColor,
  renderPagePng,
} from "../src/practice/render.js";
import {
  nextQuestionIndex,
  planAction,
  planGrade,
  type QuestionFacts,
  type SessionFacts,
} from "../src/practice/state.js";
import { notifyPracticeEvent, waitForClaim } from "../src/practice/events.js";

const ctx = {
  ownerId: "55555555-5555-4555-8555-555555555555",
  noteId: "22222222-2222-4222-8222-222222222222",
  pageIndex: 2,
};
const questionId = "11111111-1111-4111-8111-111111111111";
const PAGE_2_Y = 2 * 1080;

function userStroke(y: number, color: string): CanvasObject {
  return {
    id: crypto.randomUUID(),
    ownerId: ctx.ownerId,
    noteId: ctx.noteId,
    pageId: null,
    kind: "stroke",
    bounds: { x: 100, y, width: 50, height: 10 },
    rotation: 0,
    zIndex: 0,
    locked: false,
    groupId: null,
    payload: {
      points: [
        [100, y, 0.5],
        [150, y + 10, 0.7],
      ],
      color,
      baseWidth: 2.5,
    },
    revision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("practice marks", () => {
  it("places page-relative marks on the page's world frame as locked red objects", () => {
    const [circle] = markToObjects(
      ctx,
      { type: "circle", x: 40, y: 300, width: 120, height: 60 },
      questionId,
      1,
    );
    expect(circle!.kind).toBe("ellipse");
    expect(circle!.bounds).toEqual({
      x: 40,
      y: PAGE_2_Y + 300,
      width: 120,
      height: 60,
    });
    expect(circle!.locked).toBe(true);
    expect(circle!.payload).toMatchObject({
      color: "#ff5c5c",
      fill: null,
      strokeWidth: 3,
    });
    expect(practiceTagOf(circle!)).toEqual({
      questionId,
      attempt: 1,
      role: "mark",
    });

    const [arrow] = markToObjects(
      ctx,
      { type: "arrow", x1: 10, y1: 20, x2: 200, y2: 20 },
      questionId,
      1,
    );
    expect(arrow!.kind).toBe("arrow");
    expect(arrow!.payload.end).toEqual({ x: 200, y: PAGE_2_Y + 20 });
    expect(arrow!.bounds.height).toBeGreaterThan(0);

    const cross = markToObjects(
      ctx,
      { type: "cross", x: 400, y: 500, size: 30 },
      questionId,
      2,
    );
    expect(cross.map((o) => o.kind)).toEqual(["stroke", "stroke"]);
    expect(cross[0]!.payload.points).toEqual([
      [388, PAGE_2_Y + 488, 0.5],
      [412, PAGE_2_Y + 512, 0.5],
    ]);

    const [label] = markToObjects(
      ctx,
      { type: "text", x: 50, y: 60, text: "sign <error>" },
      questionId,
      1,
    );
    expect(label!.kind).toBe("practice-card");
    expect(label!.payload).toMatchObject({
      variant: "label",
      html: "sign &lt;error&gt;",
    });
    expect(practiceTagOf(label!)?.role).toBe("label");
  });
});

describe("practice page render", () => {
  it("draws only the question's page, darkens light ink, and fades earlier attempts", async () => {
    const onPage = userStroke(PAGE_2_Y + 400, "#e6e8ec");
    const otherPage = userStroke(1080 + 400, "#123456");
    const [oldMark] = markToObjects(
      ctx,
      { type: "box", x: 90, y: 390, width: 80, height: 30 },
      questionId,
      1,
    );
    const target = { pageIndex: 2, attempt: 2 };
    const svg = buildPageSvg([onPage, otherPage, oldMark!], target);

    expect(svg).toContain(`stroke="${inkColor("#e6e8ec")}"`);
    expect(inkColor("#e6e8ec")).not.toBe("#e6e8ec");
    expect(svg).not.toContain("#123456");
    expect(svg).toContain(`translate(0 ${-PAGE_2_Y})`);
    expect(svg).toMatch(/<g opacity="0.35"><rect[^>]*stroke="#ff5c5c"/);

    const png = await renderPagePng([onPage, oldMark!], target);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(1224); // 816 * 1.5
  });
});

describe("practice state transitions", () => {
  const session = (retry: boolean): SessionFacts => ({
    status: "active",
    totalQuestions: 2,
    options: practiceOptionsSchema.parse({ feedback: { retry } }),
  });
  const question = (patch: Partial<QuestionFacts>): QuestionFacts => ({
    index: 0,
    state: "graded",
    attempt: 1,
    maxPoints: 4,
    points: null,
    ...patch,
  });

  it("keeps the first attempt's points and only allows retry when enabled", () => {
    expect(planGrade(question({ state: "submitted" }), 3)).toEqual({
      points: 3,
      latestPoints: 3,
    });
    expect(
      planGrade(question({ state: "submitted", attempt: 2, points: 1 }), 4),
    ).toEqual({
      points: 1,
      latestPoints: 4,
    });
    expect(() => planGrade(question({ state: "submitted" }), 5)).toThrow(
      /exceeds/,
    );

    expect(() => planAction(session(false), question({}), "retry")).toThrow(
      /not enabled/,
    );
    expect(planAction(session(true), question({}), "retry")).toMatchObject({
      state: "awaiting_work",
      attempt: 2,
      event: "retry",
    });
    expect(
      planAction(session(false), question({ index: 1 }), "next"),
    ).toMatchObject({
      state: "closed",
      statusText: "Writing your summary…",
      event: "next",
    });
  });

  it("posts a new question only after every earlier one is closed", () => {
    expect(() => nextQuestionIndex(session(false), [question({})])).toThrow(
      /still graded/,
    );
    expect(
      nextQuestionIndex(session(false), [question({ state: "closed" })]),
    ).toBe(1);
    expect(() =>
      nextQuestionIndex(session(false), [
        question({ state: "closed" }),
        question({ index: 1, state: "closed" }),
      ]),
    ).toThrow(/practice_finish/);
  });
});

describe("practice wait loop", () => {
  it("wakes on notify, times out with null, and stops on abort", async () => {
    let ready = false;
    const claim = async () => (ready ? "event" : null);
    const sessionId = crypto.randomUUID();

    const waiting = waitForClaim(sessionId, 5_000, claim, undefined, 60_000);
    ready = true;
    notifyPracticeEvent(sessionId);
    await expect(waiting).resolves.toBe("event");

    await expect(
      waitForClaim(sessionId, 20, async () => null),
    ).resolves.toBeNull();

    const controller = new AbortController();
    const aborted = waitForClaim(
      sessionId,
      60_000,
      async () => null,
      controller.signal,
    );
    controller.abort();
    await expect(aborted).resolves.toBeNull();
  });
});
