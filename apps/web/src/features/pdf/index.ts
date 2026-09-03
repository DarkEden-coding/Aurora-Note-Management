// Public contract for the PDF feature: page rendering, document loading, page-relative geometry, and live page reference representation.
import "./pdfStyles.css";
import "./pdfRefStyles.css";

export { usePdfDocument, setPdfWorkerSrc } from "./usePdfDocument";
export type { PdfDocumentState } from "./usePdfDocument";
export { PdfPageView } from "./PdfPageView";
export type { PdfPageViewProps } from "./PdfPageView";
export {
  toPageRelative,
  fromPageRelative,
  rectToPageRelative,
  rectFromPageRelative,
  parseLivePageReference,
  serializeLivePageReference,
  describePageReference,
} from "./annotations";
export type { Point, PageRelativeRect, LivePageReference } from "./annotations";
