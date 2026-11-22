// Fonts and line wrapping for server page images, so typed text and agent labels wrap like the app does on a tablet.
// The app draws "sans" with system-ui, which is Roboto on Android; the server ships Roboto and measures with it.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import type { TextStyle } from "@aurora/shared";

const ROBOTO_DIR = fileURLToPath(
  new URL("../../assets/fonts/", import.meta.url),
);
// DejaVu (installed in the server image) covers serif and mono; elsewhere those fall back to Roboto.
const DEJAVU_DIR = "/usr/share/fonts/truetype/dejavu/";

function existing(dir: string, names: string[]): string[] {
  return names.map((name) => dir + name).filter((file) => fs.existsSync(file));
}

const FONT_FILES = [
  ...existing(ROBOTO_DIR, [
    "Roboto-Regular.ttf",
    "Roboto-Bold.ttf",
    "Roboto-Italic.ttf",
    "Roboto-BoldItalic.ttf",
  ]),
  ...existing(DEJAVU_DIR, [
    "DejaVuSerif.ttf",
    "DejaVuSerif-Bold.ttf",
    "DejaVuSansMono.ttf",
    "DejaVuSansMono-Bold.ttf",
  ]),
];

const SANS = "Roboto";

/** Font options for every page render; only the files above, so renders match measurements. */
export const RENDER_FONT_OPTIONS: NonNullable<ResvgRenderOptions["font"]> = {
  loadSystemFonts: false,
  fontFiles: FONT_FILES,
  defaultFontFamily: SANS,
  sansSerifFamily: SANS,
  serifFamily: "DejaVu Serif",
  monospaceFamily: "DejaVu Sans Mono",
  cursiveFamily: SANS,
};

// Families the renderer names for each stored font; handwriting has no server font, so it reads as sans.
const FAMILIES: Record<NonNullable<TextStyle["fontFamily"]>, string> = {
  sans: SANS,
  serif: "DejaVu Serif, serif",
  mono: "DejaVu Sans Mono, monospace",
  handwriting: SANS,
};

/** SVG font attributes for a text style (sans when unset). */
export function svgFontAttributes(style: TextStyle, fontSize: number): string {
  return (
    `font-family="${FAMILIES[style.fontFamily ?? "sans"]}" font-size="${fontSize}"` +
    (style.fontWeight === "bold" ? ` font-weight="bold"` : "") +
    (style.fontStyle === "italic" ? ` font-style="italic"` : "")
  );
}

const widths = new Map<string, number>();

/** Rendered width of one line of text in page units (glyph extents, as resvg lays it out). */
export function measureText(
  text: string,
  style: TextStyle,
  fontSize: number,
): number {
  if (text.trim() === "") return 0;
  const key = `${style.fontFamily}|${style.fontWeight}|${style.fontStyle}|${fontSize}|${text}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
    `<text x="0" y="${fontSize}" ${svgFontAttributes(style, fontSize)} xml:space="preserve">${escapeXml(text)}</text></svg>`;
  const width =
    new Resvg(svg, { font: RENDER_FONT_OPTIONS, logLevel: "off" }).getBBox()
      ?.width ?? 0;
  if (widths.size > 5000) widths.clear();
  widths.set(key, width);
  return width;
}

/** Splits a word that alone is wider than the box (CSS overflow-wrap: anywhere). */
function breakWord(
  word: string,
  width: number,
  style: TextStyle,
  fontSize: number,
): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const char of word) {
    if (piece !== "" && measureText(piece + char, style, fontSize) > width) {
      pieces.push(piece);
      piece = char;
    } else piece += char;
  }
  return [...pieces, piece];
}

/** Lines of text wrapped at word boundaries to the box width, like the app's text layout. */
export function wrapText(
  text: string,
  width: number,
  style: TextStyle,
  fontSize: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (measureText(candidate, style, fontSize) <= width) {
        line = candidate;
        continue;
      }
      if (line !== "") lines.push(line);
      const pieces = breakWord(word, width, style, fontSize);
      lines.push(...pieces.slice(0, -1));
      line = pieces.at(-1)!;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Largest whole font size up to maxSize whose wrapped text fits the box height, like the app's
 * rich-text boxes shrinking their text to fit (never below 8).
 */
export function fitFontSize(
  text: string,
  box: { width: number; height: number },
  style: TextStyle,
  maxSize: number,
  lineHeight: number,
): number {
  const fits = (size: number) =>
    wrapText(text, box.width, style, size).length * size * lineHeight <=
    box.height + 0.5;
  let low = 8;
  let high = Math.max(low, Math.floor(maxSize));
  if (fits(high)) return high;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid;
  }
  return low;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
