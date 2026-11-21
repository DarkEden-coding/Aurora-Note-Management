// Renders a practice-card canvas object: sanitized, KaTeX-rendered HTML inside a shadow root with the card base stylesheet. Cards let pen input pass through; the solution variant starts collapsed behind a local show/hide toggle.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
// Shadow roots ignore @font-face, so KaTeX fonts must also be declared at document level.
import "katex/dist/katex.min.css";
import { cardVariant, mountCard, type CardVariant } from "./mountCard";
import "./practice.css";

function CardShadow({
  variant,
  html,
  payload,
}: {
  variant: CardVariant;
  html: string;
  payload: Record<string, unknown>;
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    mountCard(host, variant, html, payload);
  }, [html, variant, payload]);

  return <div ref={hostRef} className="practice-card-host" />;
}

export function PracticeCard({
  payload,
}: {
  payload: Record<string, unknown>;
}): ReactNode {
  const variant = cardVariant(payload);
  const html = typeof payload.html === "string" ? payload.html : "";
  const [revealed, setRevealed] = useState(false);

  if (variant !== "solution")
    return <CardShadow variant={variant} html={html} payload={payload} />;
  return (
    <div className="practice-solution">
      {revealed ? (
        <CardShadow variant={variant} html={html} payload={payload} />
      ) : null}
      <button
        type="button"
        className="practice-solution-toggle"
        aria-expanded={revealed}
        // Keep the tap away from the canvas so it neither inks nor pans.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? "Hide solution" : "Show solution"}
      </button>
    </div>
  );
}
