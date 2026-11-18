// Measures the question card's labelled elements ([data-option], [data-region], .final-answer) in card units when the user presses Done, so Claude can see where each sits on the page.
import type { PracticeCardRegion } from "@aurora/shared";

const LABELLED = "[data-option], [data-region], .final-answer";
const MAX_REGIONS = 40;
const MAX_TEXT = 300;

const round = (n: number): number => Math.round(n * 10) / 10;

/** Visible text with KaTeX output turned back into its TeX source ($...$). */
function readableText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const math of copy.querySelectorAll(".katex")) {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]');
    math.replaceWith(tex ? `$${tex.textContent ?? ""}$` : "");
  }
  return (copy.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

function regionOf(
  element: Element,
): Omit<PracticeCardRegion, "x" | "y" | "width" | "height"> {
  const option = element.getAttribute("data-option");
  if (option !== null) return { kind: "option", label: option.slice(0, 80) };
  const name = (element.getAttribute("data-region") ?? "").slice(0, 80);
  if (element.classList.contains("final-answer")) {
    return { kind: "finalAnswer", label: name || "final" };
  }
  return { kind: "region", label: name };
}

/**
 * Card-relative bounds of every labelled element of the mounted card object, or undefined
 * when the card is not on screen. Canvas zoom is divided out, so units match page units.
 */
export function measureCardRegions(
  objectId: string | null,
): PracticeCardRegion[] | undefined {
  if (objectId === null) return undefined;
  const host = document.querySelector<HTMLElement>(
    `[data-html-object="${CSS.escape(objectId)}"] .practice-card-host`,
  );
  const card = host?.shadowRoot?.querySelector(".card");
  if (!host || !card || host.offsetWidth === 0) return undefined;
  const origin = host.getBoundingClientRect();
  const zoom = origin.width / host.offsetWidth;
  const regions: PracticeCardRegion[] = [];
  for (const element of card.querySelectorAll(LABELLED)) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const text = readableText(element);
    regions.push({
      ...regionOf(element),
      x: round((rect.left - origin.left) / zoom),
      y: round((rect.top - origin.top) / zoom),
      width: round(rect.width / zoom),
      height: round(rect.height / zoom),
      ...(text ? { text } : {}),
    });
    if (regions.length === MAX_REGIONS) break;
  }
  return regions;
}
