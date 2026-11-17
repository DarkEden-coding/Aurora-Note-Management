// Renders a practice-card canvas object: sanitized, KaTeX-rendered HTML inside a shadow root with the card base stylesheet. Cards let pen input pass through; the solution variant starts collapsed behind a local show/hide toggle.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import katexCss from "katex/dist/katex.min.css?inline";
// Shadow roots ignore @font-face, so KaTeX fonts must also be declared at document level.
import "katex/dist/katex.min.css";
import { buildCardContent } from "./cardContent";
import { PRACTICE_CARD_CSS } from "@aurora/shared";
import hostCss from "./practiceCard.css?inline";
import "./practice.css";

type Variant = "prompt" | "feedback" | "solution" | "label" | "summary";

const VARIANTS: readonly string[] = [
  "prompt",
  "feedback",
  "solution",
  "label",
  "summary",
];

let sharedSheet: CSSStyleSheet | null = null;

/** One constructed stylesheet shared by every card's shadow root. */
function cardStyleSheet(): CSSStyleSheet {
  if (sharedSheet === null) {
    sharedSheet = new CSSStyleSheet();
    sharedSheet.replaceSync(`${katexCss}\n${hostCss}\n${PRACTICE_CARD_CSS}`);
  }
  return sharedSheet;
}

function CardShadow({
  variant,
  html,
}: {
  variant: Variant;
  html: string;
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.adoptedStyleSheets = [cardStyleSheet()];
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.variant = variant;
    card.append(buildCardContent(html));
    root.replaceChildren(card);
  }, [html, variant]);

  return <div ref={hostRef} className="practice-card-host" />;
}

export function PracticeCard({
  payload,
}: {
  payload: Record<string, unknown>;
}): ReactNode {
  const variant: Variant = VARIANTS.includes(payload.variant as string)
    ? (payload.variant as Variant)
    : "prompt";
  const html = typeof payload.html === "string" ? payload.html : "";
  const [revealed, setRevealed] = useState(false);

  if (variant !== "solution")
    return <CardShadow variant={variant} html={html} />;
  return (
    <div className="practice-solution">
      {revealed ? <CardShadow variant={variant} html={html} /> : null}
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
