// Chat transcript, streaming composer, HTML workbench, and tool activity.
import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  LoaderCircle,
  Square,
  TriangleAlert,
} from "lucide-react";
import type {
  AiAuthStatus,
  ChatConversation,
  ChatMessage,
} from "@aurora/shared";
import { HtmlArtifact } from "./HtmlArtifact.js";
import { HtmlWorkbench, type HtmlWorkbenchHandle } from "./HtmlWorkbench.js";
import { MarkdownText } from "./MarkdownText.js";
import { runAgentTurn, type ToolProgress } from "./agentLoop.js";
import * as chatApi from "./api.js";
import "./chatStyles.css";

export function ChatView({
  conversation,
  onConversationUpdated,
}: {
  conversation: ChatConversation | null;
  onConversationUpdated: (conversation: ChatConversation) => void;
}) {
  const [auth, setAuth] = useState<AiAuthStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [toolProgress, setToolProgress] = useState<ToolProgress[]>([]);
  const [error, setError] = useState<string | null>(null);
  const workbenchRef = useRef<HtmlWorkbenchHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const messageLoadRef = useRef(0);

  useEffect(() => {
    void chatApi
      .getAiAuthStatus()
      .then(setAuth)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    const loadId = ++messageLoadRef.current;
    setMessages([]);
    setStreamText("");
    setToolProgress([]);
    setError(null);
    if (!conversation) return;
    void chatApi
      .listMessages(conversation.id)
      .then((result) => {
        if (messageLoadRef.current === loadId) setMessages(result.messages);
      })
      .catch(() => {
        if (messageLoadRef.current === loadId) {
          setError("Could not load this chat.");
        }
      });
    return () => {
      messageLoadRef.current += 1;
      abortRef.current?.abort();
    };
  }, [conversation?.id]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streamText, toolProgress]);

  const send = async () => {
    if (!conversation || !draft.trim() || busy || !workbenchRef.current) return;
    const text = draft.trim();
    messageLoadRef.current += 1;
    setDraft("");
    setBusy(true);
    setError(null);
    setStreamText("");
    setToolProgress([]);
    const controller = new AbortController();
    abortRef.current = controller;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      role: "user",
      parts: [{ type: "text", text }],
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, userMessage]);
    let turnFailed = false;
    try {
      await runAgentTurn({
        conversationId: conversation.id,
        projectId: conversation.projectId,
        incoming: [{ role: "user", parts: [{ type: "text", text }] }],
        workbench: workbenchRef.current,
        signal: controller.signal,
        handlers: {
          onTextDelta: (delta) => {
            if (!controller.signal.aborted) {
              setStreamText((current) => current + delta);
            }
          },
          onAssistant: (message) => {
            if (controller.signal.aborted) return;
            setStreamText("");
            setMessages((current) => [...current, message]);
          },
          onToolProgress: (progress) => {
            if (controller.signal.aborted) return;
            setToolProgress((current) => {
              const existing = current.findIndex(
                (item) => item.callId === progress.callId,
              );
              if (existing === -1) return [...current, progress];
              return current.map((item, index) =>
                index === existing ? progress : item,
              );
            });
          },
          onError: (message) => {
            turnFailed = true;
            setError(message);
          },
        },
      });
      if (!turnFailed && !controller.signal.aborted) {
        void chatApi
          .listConversations(conversation.projectId)
          .then(({ conversations }) => {
            if (controller.signal.aborted) return;
            const updated = conversations.find(
              (item) => item.id === conversation.id,
            );
            if (updated) onConversationUpdated(updated);
          })
          .catch(() => undefined);
      }
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "Turn failed");
      }
    } finally {
      if (abortRef.current === controller) {
        setBusy(false);
        setStreamText("");
        abortRef.current = null;
      }
    }
  };

  if (!conversation) {
    return (
      <div className="canvas-area">
        <div className="canvas-empty">
          Select or create a chat in a project folder.
        </div>
      </div>
    );
  }

  return (
    <div className="chat-view">
      {auth && !auth.connected ? (
        <div className="chat-banner">
          Connect ChatGPT in Account settings (device code). Enable device login
          in ChatGPT security settings first.
        </div>
      ) : null}
      <div className="chat-transcript" ref={listRef}>
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {streamText ? (
          <div className="chat-bubble assistant">
            <MarkdownText>{streamText}</MarkdownText>
          </div>
        ) : null}
        {toolProgress.length > 0 ? (
          <ToolProgressPanel progress={toolProgress} />
        ) : null}
        <HtmlWorkbench ref={workbenchRef} />
        {error ? (
          <div className="error-text" role="alert">
            {error}
          </div>
        ) : null}
      </div>
      <form
        className="chat-composer panel"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          rows={1}
          placeholder="Ask about this project's notes…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          type={busy ? "button" : "submit"}
          className="ghost icon-button"
          disabled={!busy && !draft.trim()}
          aria-label={busy ? "Stop response" : "Send"}
          onClick={busy ? () => abortRef.current?.abort() : undefined}
        >
          {busy ? <Square size={14} /> : <ArrowUp size={16} />}
        </button>
      </form>
    </div>
  );
}

/** Shows tool activity from the current turn as it advances. */
function ToolProgressPanel({ progress }: { progress: ToolProgress[] }) {
  return (
    <div className="chat-tool-progress panel" aria-live="polite">
      <div className="chat-tool-progress-title">Agent activity</div>
      {progress.map((item) => (
        <div className="chat-tool-progress-row" key={item.callId}>
          {item.status === "running" ? (
            <LoaderCircle size={13} className="spin" />
          ) : item.status === "completed" ? (
            <Check size={13} />
          ) : item.status === "failed" ? (
            <TriangleAlert size={13} />
          ) : (
            <span className="chat-tool-progress-dot" />
          )}
          <span>{toolProgressLabel(item)}</span>
          <span className={`chat-tool-progress-status ${item.status}`}>
            {item.status === "queued"
              ? "Waiting"
              : item.status === "running"
                ? "Running"
                : item.status === "failed"
                  ? "Failed"
                  : "Done"}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Produces a concise description without displaying bulky tool arguments. */
function toolProgressLabel(progress: ToolProgress): string {
  switch (progress.name) {
    case "list_notes":
      return "List project notes";
    case "read_note":
      return "Read note";
    case "grep_notes":
      return typeof progress.arguments.pattern === "string"
        ? `Search notes for “${progress.arguments.pattern}”`
        : "Search notes";
    case "screenshot_note":
      return "Capture note preview";
    case "html_render":
      return "Render visualization";
    case "html_act":
      return "Interact with visualization";
    case "html_submit":
      return "Submit visualization";
    default:
      return progress.name;
  }
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "tool") return null;
  const visible = message.parts.filter(
    (part) => part.type === "text" || part.type === "html",
  );
  if (visible.length === 0) return null;
  const hasHtml = visible.some((part) => part.type === "html");
  return (
    <div className={`chat-bubble ${message.role}${hasHtml ? " has-html" : ""}`}>
      {visible.map((part, index) => {
        if (part.type === "text") {
          return message.role === "assistant" ? (
            <MarkdownText key={index}>{part.text}</MarkdownText>
          ) : (
            <div key={index} className="chat-text">
              {part.text}
            </div>
          );
        }
        if (part.type === "html") {
          return (
            <HtmlArtifact key={index} title={part.title} html={part.html} />
          );
        }
        return null;
      })}
    </div>
  );
}
