// Mounts one practice card (sanitized, KaTeX-rendered HTML plus the card stylesheet) into a host element's shadow root. Shared by the canvas component and the Android renderer page.
import katexCss from "katex/dist/katex.min.css?inline";
import { PRACTICE_CARD_CSS, textStyleCss } from "@aurora/shared";
import { buildCardContent } from "./cardContent";
import hostCss from "./practiceCard.css?inline";

export type CardVariant =
  "prompt" | "feedback" | "solution" | "label" | "summary";

const VARIANTS: readonly string[] = [
  "prompt",
  "feedback",
  "solution",
  "label",
  "summary",
];

export function cardVariant(payload: Record<string, unknown>): CardVariant {
  return VARIANTS.includes(payload.variant as string)
    ? (payload.variant as CardVariant)
    : "prompt";
}

let sharedSheet: CSSStyleSheet | null = null;

/** One constructed stylesheet shared by every card's shadow root. */
function cardStyleSheet(): CSSStyleSheet {
  if (sharedSheet === null) {
    sharedSheet = new CSSStyleSheet();
    sharedSheet.replaceSync(`${katexCss}\n${hostCss}\n${PRACTICE_CARD_CSS}`);
  }
  return sharedSheet;
}

export function mountCard(
  host: HTMLElement,
  variant: CardVariant,
  html: string,
  payload: Record<string, unknown> = {},
): void {
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  root.adoptedStyleSheets = [cardStyleSheet()];
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.variant = variant;
  // Label cards (agent text marks) carry their own font and color.
  if (variant === "label") Object.assign(card.style, textStyleCss(payload));
  card.append(buildCardContent(html));
  root.replaceChildren(card);
}
