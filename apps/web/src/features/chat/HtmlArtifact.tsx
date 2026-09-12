// Chat HTML artifact card: sandboxed iframe, expand, source, copy.
import { useMemo, useState } from "react";
import { Code, Copy, Expand, Minimize2 } from "lucide-react";
import { buildSrcdoc, themeVarsFrom } from "./sandboxBridge.js";

export function HtmlArtifact({ title, html }: { title: string; html: string }) {
  const [expanded, setExpanded] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const srcdoc = useMemo(() => buildSrcdoc(html, themeVarsFrom()), [html]);

  const card = (
    <div className={`chat-html-card panel${expanded ? " expanded" : ""}`}>
      <div className="chat-html-toolbar">
        <span className="label">{title}</span>
        <button
          type="button"
          className="ghost icon-button"
          aria-label="Show HTML source"
          onClick={() => setShowCode((value) => !value)}
        >
          <Code size={14} />
        </button>
        <button
          type="button"
          className="ghost icon-button"
          aria-label="Copy HTML"
          onClick={() => void navigator.clipboard.writeText(html)}
        >
          <Copy size={14} />
        </button>
        <button
          type="button"
          className="ghost icon-button"
          aria-label={expanded ? "Exit fullscreen" : "Expand visualization"}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <Minimize2 size={14} /> : <Expand size={14} />}
        </button>
      </div>
      {showCode ? (
        <pre className="chat-html-source">{html}</pre>
      ) : (
        <iframe
          className="chat-html-frame"
          title={title}
          sandbox="allow-scripts"
          srcDoc={srcdoc}
        />
      )}
    </div>
  );

  if (!expanded) return card;
  return (
    <div className="chat-html-overlay" onClick={() => setExpanded(false)}>
      <div onClick={(event) => event.stopPropagation()}>{card}</div>
    </div>
  );
}
