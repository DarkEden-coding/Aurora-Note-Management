import {
  mathQuestionSchema,
  type Background,
  type CanvasObject,
  type MathSolveEvent,
  type MathSolveRequest,
} from "@aurora/shared";
import { renderNoteRegion } from "../chat/noteSnapshot";
import type { Point } from "./viewport";

export type ScreenRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Normalizes and clamps a dragged screen region to the viewport. */
export function normalizeRegion(
  start: Point,
  end: Point,
  width: number,
  height: number,
): ScreenRegion {
  const left = Math.max(0, Math.min(start.x, end.x));
  const top = Math.max(0, Math.min(start.y, end.y));
  const right = Math.min(width, Math.max(start.x, end.x));
  const bottom = Math.min(height, Math.max(start.y, end.y));
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** Expands a selected region around its center without leaving the viewport. */
export function expandResultRegion(
  region: ScreenRegion,
  viewportWidth: number,
  viewportHeight: number,
): ScreenRegion {
  const margin = 12;
  const width = Math.min(
    Math.max(1, viewportWidth - margin * 2),
    Math.max(region.width, 620),
  );
  const height = Math.min(
    Math.max(1, viewportHeight - margin * 2),
    Math.max(region.height, 340),
  );
  return {
    x: Math.max(
      margin,
      Math.min(
        region.x + region.width / 2 - width / 2,
        viewportWidth - width - margin,
      ),
    ),
    y: Math.max(
      margin,
      Math.min(
        region.y + region.height / 2 - height / 2,
        viewportHeight - height - margin,
      ),
    ),
    width,
    height,
  };
}

/** Renders a canvas-coordinate note region without workspace UI or transforms. */
export async function captureMathRegion(
  objects: CanvasObject[],
  region: ScreenRegion,
  background: Background,
): Promise<string> {
  return renderNoteRegion(objects, { ...region, background });
}

/** Streams validated solver events and fails rather than presenting a truncated answer. */
export async function* streamMathSolution(
  request: MathSolveRequest,
  signal?: AbortSignal,
): AsyncGenerator<MathSolveEvent> {
  const response = await fetch("/api/ai/math/solve", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: unknown };
    } | null;
    throw new Error(
      typeof body?.error?.message === "string"
        ? body.error.message
        : `Math solver failed (${response.status})`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk
          .split("\n")
          .find((entry) => entry.startsWith("data: "));
        if (!line) continue;
        let event: unknown;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          throw new Error("Math solver sent an invalid response");
        }
        if (typeof event !== "object" || event === null || !("type" in event))
          throw new Error("Math solver sent an invalid response");
        const message = (event as { message?: unknown }).message;
        if (event.type === "error" && typeof message === "string")
          throw new Error(message);
        if (event.type === "questions") {
          const questions = (event as { questions?: unknown }).questions;
          const parsed = mathQuestionSchema.array().safeParse(questions);
          if (!parsed.success)
            throw new Error("Math solver sent invalid clarification questions");
          yield { type: "questions", questions: parsed.data };
          continue;
        }
        if (
          (event.type === "reasoning-delta" || event.type === "text-delta") &&
          typeof (event as { delta?: unknown }).delta === "string"
        ) {
          yield event as MathSolveEvent;
          continue;
        }
        if (
          event.type === "reasoning-done" ||
          event.type === "python-start" ||
          event.type === "python-result" ||
          event.type === "done"
        ) {
          if (
            event.type === "python-start" &&
            typeof (event as { code?: unknown }).code !== "string"
          )
            throw new Error("Math solver sent an invalid response");
          if (
            event.type === "python-result" &&
            (typeof (event as { output?: unknown }).output !== "string" ||
              typeof (event as { success?: unknown }).success !== "boolean")
          )
            throw new Error("Math solver sent an invalid response");
          if (event.type === "done") completed = true;
          yield event as MathSolveEvent;
          continue;
        }
        throw new Error("Math solver sent an invalid response");
      }
    }
    if (buffer.trim()) throw new Error("Math solver response was truncated");
    if (!completed) throw new Error("Math solver response was truncated");
  } finally {
    reader.releaseLock();
  }
}
