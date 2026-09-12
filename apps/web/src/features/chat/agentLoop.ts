// Runs one user turn: stream the model, execute tools in the browser, post results back.
import type { ChatMessage, ChatPart, HtmlAct } from "@aurora/shared";
import { aiToolCallSchema } from "@aurora/shared";
import type { HtmlWorkbenchHandle } from "./HtmlWorkbench.js";
import * as chatApi from "./api.js";
import { screenshotNote } from "./noteSnapshot.js";

const MAX_ROUNDS = 16;

export type TurnHandlers = {
  onTextDelta: (delta: string) => void;
  onAssistant: (message: ChatMessage) => void;
  onError: (message: string) => void;
};

export async function runAgentTurn(params: {
  conversationId: string;
  projectId: string;
  incoming: Array<{ role: "user" | "tool"; parts: ChatPart[] }>;
  workbench: HtmlWorkbenchHandle;
  signal?: AbortSignal;
  handlers: TurnHandlers;
}): Promise<void> {
  let next = params.incoming;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let assistant: ChatMessage | null = null;
    const calls: Array<{
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
    }> = [];
    for await (const event of chatApi.streamTurn(
      params.conversationId,
      next,
      params.signal,
    )) {
      if (event.type === "text-delta") params.handlers.onTextDelta(event.delta);
      if (event.type === "tool-call") calls.push(event);
      if (event.type === "error") {
        params.handlers.onError(event.message);
        return;
      }
      if (event.type === "done") assistant = event.message;
    }
    if (assistant) params.handlers.onAssistant(assistant);
    if (!assistant || calls.length === 0) return;
    const parts: ChatPart[] = [];
    for (const call of calls) {
      const result = await executeTool(
        call,
        params.projectId,
        params.workbench,
      );
      parts.push(result);
    }
    next = [{ role: "tool", parts }];
  }
}

async function executeTool(
  call: { callId: string; name: string; arguments: Record<string, unknown> },
  projectId: string,
  workbench: HtmlWorkbenchHandle,
): Promise<ChatPart> {
  const parsed = aiToolCallSchema.safeParse({
    name: call.name,
    arguments: call.arguments ?? {},
  });
  if (!parsed.success) {
    return {
      type: "tool-result",
      callId: call.callId,
      output: `Invalid tool arguments: ${parsed.error.message}`,
    };
  }
  try {
    switch (parsed.data.name) {
      case "list_notes": {
        const { notes } = await chatApi.listProjectNotes(projectId);
        return {
          type: "tool-result",
          callId: call.callId,
          output: JSON.stringify(notes),
        };
      }
      case "read_note": {
        const note = await chatApi.readNoteText(
          parsed.data.arguments.noteId,
          projectId,
        );
        return {
          type: "tool-result",
          callId: call.callId,
          output: `# ${note.title}\n\n${note.text || "(no text)"}`,
        };
      }
      case "grep_notes": {
        const { hits } = await chatApi.grepProjectNotes(
          projectId,
          parsed.data.arguments.pattern,
        );
        return {
          type: "tool-result",
          callId: call.callId,
          output: JSON.stringify(hits),
        };
      }
      case "screenshot_note": {
        const tile = parsed.data.arguments.tile ?? 0;
        const shot = await screenshotNote(parsed.data.arguments.noteId, tile);
        return {
          type: "tool-result",
          callId: call.callId,
          output: JSON.stringify({
            tile,
            tileCount: shot.tileCount,
            truncated: shot.truncated,
            nextTile: tile + 1 < shot.tileCount ? tile + 1 : null,
          }),
          images: shot.images,
        };
      }
      case "html_render": {
        const result = await workbench.render(parsed.data.arguments.html);
        return {
          type: "tool-result",
          callId: call.callId,
          output: result.errors.length
            ? `errors: ${result.errors.join("; ")}`
            : "rendered",
          images: [result.screenshot],
        };
      }
      case "html_act": {
        const result = await workbench.act(
          parsed.data.arguments.actions as HtmlAct[],
          parsed.data.arguments.waitMs,
        );
        return {
          type: "tool-result",
          callId: call.callId,
          output: result.errors.length
            ? `errors: ${result.errors.join("; ")}`
            : "acted",
          images: [result.screenshot],
        };
      }
      case "html_submit": {
        return {
          type: "tool-result",
          callId: call.callId,
          output: "submitted",
        };
      }
    }
  } catch (error) {
    return {
      type: "tool-result",
      callId: call.callId,
      output: error instanceof Error ? error.message : "Tool failed",
    };
  }
}
