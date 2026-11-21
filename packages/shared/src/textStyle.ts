// Font and color of typed text (rich-text boxes and practice label cards), stored as flat payload fields and read by every renderer.
import { z } from "zod";

// Readable families an agent or client may choose; "sans" is the default.
export const TEXT_FONT_STACKS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "DejaVu Sans", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", "DejaVu Serif", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
  handwriting: '"Comic Neue", "Segoe Print", "Bradley Hand", cursive',
} as const;

export const textFontSchema = z.enum(["sans", "serif", "mono", "handwriting"]);
export type TextFont = z.infer<typeof textFontSchema>;

export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color like #1f6feb");

export const textStyleSchema = z.object({
  fontFamily: textFontSchema.optional(),
  fontSize: z.number().min(8).max(96).optional(),
  fontWeight: z.enum(["normal", "bold"]).optional(),
  fontStyle: z.enum(["normal", "italic"]).optional(),
  color: hexColorSchema.optional(),
});
export type TextStyle = z.infer<typeof textStyleSchema>;

/** The valid text style fields stored on an object's payload; invalid or missing fields are left out. */
export function textStyleOf(payload: Record<string, unknown>): TextStyle {
  const style: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(textStyleSchema.shape)) {
    const value = field.safeParse(payload[key]);
    if (value.success && value.data !== undefined) style[key] = value.data;
  }
  return style as TextStyle;
}

/** CSS declarations for the payload's text style; only fields that are set. */
export function textStyleCss(payload: Record<string, unknown>): {
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  fontStyle?: string;
  color?: string;
} {
  const style = textStyleOf(payload);
  return {
    ...(style.fontFamily
      ? { fontFamily: TEXT_FONT_STACKS[style.fontFamily] }
      : {}),
    ...(style.fontSize ? { fontSize: `${style.fontSize}px` } : {}),
    ...(style.fontWeight ? { fontWeight: style.fontWeight } : {}),
    ...(style.fontStyle ? { fontStyle: style.fontStyle } : {}),
    ...(style.color ? { color: style.color } : {}),
  };
}
