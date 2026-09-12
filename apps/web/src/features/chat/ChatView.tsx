// Chat transcript, streaming composer, HTML workbench, and tool activity.
import { useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle } from "lucide-react";
import type {
  AiAuthStatus,
  ChatConversation,
  ChatMessage,
} from "@aurora/shared";
import { HtmlArtifact } from "./HtmlArtifact.js";
import { HtmlWorkbench, type HtmlWorkbenchHandle } from "./HtmlWorkbench.js";
import { runAgentTurn } from "./agentLoop.js";
import * as chatApi from "./api.js";
import "./chatStyles.css";

export function ChatView({
  conversation,
}: {
  conversation: ChatConversation | null;
}) {
  const [auth, setAuth] = useState<AiAuthStatus | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const workbenchRef = useRef<HtmlWorkbenchHandle>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void chatApi
      .getAiAuthStatus()
      .then(setAuth)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    setStreamText("");
    setError(null);
    if (!conversation) {
      setMessages([]);
      return;
    }
    void chatApi
      .listMessages(conversation.id)
      .then((result) => setMessages(result.messages))
      .catch(() => setMessages([]));
  }, [conversation?.id]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, streamText]);

  const send = async () => {
    if (!conversation || !draft.trim() || busy || !workbenchRef.current) return;
    const text = draft.trim();
    setDraft("");
    setBusy(true);
    setError(null);
    setStreamText("");
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
    try {
      await runAgentTurn({
        conversationId: conversation.id,
        projectId: conversation.projectId,
        incoming: [{ role: "user", parts: [{ type: "text", text }] }],
        workbench: workbenchRef.current,
        signal: controller.signal,
        handlers: {
          onTextDelta: (delta) => setStreamText((current) => current + delta),
          onAssistant: (message) => {
            setStreamText("");
            setMessages((current) => [...current, message]);
          },
          onError: (message) => setError(message),
        },
      });
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "Turn failed");
      }
    } finally {
      setBusy(false);
      setStreamText("");
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
            <div className="chat-text">{streamText}</div>
          </div>
        ) : null}
        <HtmlWorkbench ref={workbenchRef} visible={busy} />
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
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="submit"
          className="ghost icon-button"
          disabled={busy || !draft.trim()}
          aria-label="Send"
        >
          {busy ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <ArrowUp size={16} />
          )}
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "tool") return null;
  const tools = message.parts.filter((part) => part.type === "tool-call");
  const visible = message.parts.filter(
    (part) => part.type === "text" || part.type === "html",
  );
  return (
    <div className={`chat-bubble ${message.role}`}>
      {tools.map((part) =>
        part.type === "tool-call" ? (
          <div key={part.callId} className="chat-tool">
            {toolLabel(part.name)}
          </div>
        ) : null,
      )}
      {visible.map((part, index) => {
        if (part.type === "text") {
          return (
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

function toolLabel(name: string): string {
  switch (name) {
    case "list_notes":
      return "Listed notes";
    case "read_note":
      return "Read a note";
    case "grep_notes":
      return "Searched notes";
    case "screenshot_note":
      return "Captured a note";
    case "html_render":
      return "Rendered HTML";
    case "html_act":
      return "Interacted with HTML";
    case "html_submit":
      return "Submitted visualization";
    default:
      return name;
  }
}
