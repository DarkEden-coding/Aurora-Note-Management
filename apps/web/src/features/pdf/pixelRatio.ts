// Render resolution override for PDF pages: print exports set a fixed pixel ratio so pages stay sharp when scaled to the sheet; screens use the device pixel ratio.
import { createContext } from "react";

/** Device pixels per CSS pixel for PDF page renders; `null` follows the screen. */
export const PdfPixelRatioContext = createContext<number | null>(null);
