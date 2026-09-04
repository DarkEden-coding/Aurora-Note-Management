// Renders individual canvas objects: SVG shapes and pressure strokes for the scene layer, HTML for rich text, media, attachments, and embedded PDF references. Renderer stays presentation-only; mutations flow through callbacks.
import { type ReactNode, useRef, useState } from "react";
import type { CanvasObject } from "@aurora/shared";
import { FileText, GripHorizontal } from "lucide-react";
import { EMPTY_DOC, RichTextBlock } from "../editor";
import { describePageReference, PdfPageView } from "../pdf";
import "./pdfRefChrome.css";
import {
  getAttachmentName,
  getAttachmentSize,
  getImageAlt,
  getArrowHeadGeometry,
  getImageSrc,
  getLineEndpoints,
  getRichTextDoc,
  getShapeColor,
  getShapeCornerRadius,
  getShapeDashArray,
  getShapeFill,
  getShapeStrokeWidth,
  getStickyColor,
  getStickyText,
  getStrokeBaseWidth,
  getStrokeColor,
  getStrokePoints,
  getPdfPageReference,
  type StrokePoint,
} from "./objects";

// ---- Scene layer (SVG) ---------------------------------------------------

/** Pressure stroke path: one segment per point pair, stroke width driven by pressure. */
export function PressureStrokePath({
  points,
  color,
  baseWidth,
}: {
  points: StrokePoint[];
  color: string;
  baseWidth: number;
}): ReactNode {
  const segments: ReactNode[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    segments.push(
      <path
        key={i}
        d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`}
        stroke={color}
        strokeWidth={Math.max(0.5, baseWidth * (0.3 + a.pressure))}
        strokeLinecap="round"
        fill="none"
      />,
    );
  }
  return <g>{segments}</g>;
}

/** Renders one scene-layer object (strokes and vector shapes) as an SVG fragment. */
export function SceneObject({ object }: { object: CanvasObject }): ReactNode {
  switch (object.kind) {
    case "stroke": {
      const points = getStrokePoints(object);
      if (points.length === 0) return null;
      return (
        <PressureStrokePath
          points={points}
          color={getStrokeColor(object)}
          baseWidth={getStrokeBaseWidth(object)}
        />
      );
    }
    case "rectangle": {
      const b = object.bounds;
      return (
        <rect
          x={b.x}
          y={b.y}
          width={b.width}
          height={b.height}
          rx={Math.min(getShapeCornerRadius(object), b.width / 2, b.height / 2)}
          stroke={getShapeColor(object)}
          strokeWidth={getShapeStrokeWidth(object)}
          strokeDasharray={getShapeDashArray(object)}
          strokeLinecap={
            object.payload.lineStyle === "dotted" ? "round" : undefined
          }
          fill={getShapeFill(object) ?? "none"}
        />
      );
    }
    case "ellipse": {
      const b = object.bounds;
      return (
        <ellipse
          cx={b.x + b.width / 2}
          cy={b.y + b.height / 2}
          rx={b.width / 2}
          ry={b.height / 2}
          stroke={getShapeColor(object)}
          strokeWidth={getShapeStrokeWidth(object)}
          strokeDasharray={getShapeDashArray(object)}
          strokeLinecap={
            object.payload.lineStyle === "dotted" ? "round" : undefined
          }
          fill={getShapeFill(object) ?? "none"}
        />
      );
    }
    case "line": {
      const { start, end } = getLineEndpoints(object);
      return (
        <line
          x1={start.x}
          y1={start.y}
          x2={end.x}
          y2={end.y}
          stroke={getShapeColor(object)}
          strokeWidth={getShapeStrokeWidth(object)}
          strokeDasharray={getShapeDashArray(object)}
          strokeLinecap="round"
        />
      );
    }
    case "arrow": {
      const { start, end } = getLineEndpoints(object);
      const { wing1, wing2 } = getArrowHeadGeometry(start, end);
      return (
        <g
          stroke={getShapeColor(object)}
          strokeWidth={getShapeStrokeWidth(object)}
          strokeDasharray={getShapeDashArray(object)}
          strokeLinecap="round"
          fill="none"
        >
          <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
          <polygon
            points={`${end.x},${end.y} ${wing1.x},${wing1.y} ${wing2.x},${wing2.y}`}
            fill={getShapeColor(object)}
            stroke="none"
          />
        </g>
      );
    }
    default:
      return null;
  }
}

// ---- HTML layer ----------------------------------------------------------

export interface HtmlObjectCallbacks {
  onRichTextChange: (id: string, doc: Record<string, unknown>) => void;
  onStickyTextChange: (id: string, text: string) => void;
}

export interface HtmlObjectProps {
  object: CanvasObject;
  /** Whether gesture/edit chrome is enabled (tool is select and object is unlocked). */
  interactive: boolean;
  /** Whether the object is selected; drives the move grip on rich-text objects. */
  selected: boolean;
  callbacks: HtmlObjectCallbacks;
}

/** Renders one positioned HTML object (rich text, sticky, image, attachment, PDF reference). */
export function HtmlObject({
  object,
  interactive,
  selected,
  callbacks,
}: HtmlObjectProps): ReactNode {
  const b = object.bounds;
  const richText = object.kind === "rich-text";
  return (
    <div
      className="canvas-html-object"
      data-html-object={object.id}
      data-interactive={interactive ? "true" : "false"}
      style={{
        left: b.x,
        top: b.y,
        width: b.width,
        height: b.height,
        rotate: `${object.rotation}deg`,
      }}
    >
      {richText && interactive && selected ? (
        <div
          className="canvas-move-grip"
          data-move-grip="true"
          title="Drag to move"
        >
          <GripHorizontal size={12} />
        </div>
      ) : null}
      <HtmlContent
        object={object}
        interactive={interactive}
        selected={selected}
        callbacks={callbacks}
      />
    </div>
  );
}

function HtmlContent({
  object,
  interactive,
  selected,
  callbacks,
}: HtmlObjectProps & { selected: boolean }): ReactNode {
  switch (object.kind) {
    case "rich-text": {
      const doc = getRichTextDoc(object) ?? EMPTY_DOC;
      return (
        <div
          className="rich-text-block"
          data-rich-text-editable={interactive ? "true" : "false"}
        >
          <RichTextBlock
            content={doc}
            editable={interactive}
            onChange={(json) => callbacks.onRichTextChange(object.id, json)}
          />
        </div>
      );
    }
    case "sticky-note":
      return (
        <StickyContent
          object={object}
          interactive={interactive}
          callbacks={callbacks}
        />
      );
    case "image": {
      const src = getImageSrc(object);
      return (
        <div className="canvas-image">
          {src !== null ? (
            <img
              className="canvas-image-img"
              src={src}
              alt={getImageAlt(object)}
              draggable={false}
            />
          ) : null}
        </div>
      );
    }
    case "attachment":
      return <AttachmentContent object={object} />;
    case "pdf-page-reference":
      return <PdfRefContent object={object} />;
    default:
      return null;
  }
}

function StickyContent({
  object,
  interactive,
  callbacks,
}: {
  object: CanvasObject;
  interactive: boolean;
  callbacks: HtmlObjectCallbacks;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;

  return (
    <div
      className="canvas-sticky"
      data-editing={editing ? "true" : "false"}
      style={{ backgroundColor: getStickyColor(object) }}
      onDoubleClick={() => {
        if (interactive) setEditing(true);
      }}
    >
      <div
        className="canvas-sticky-text"
        contentEditable={editing}
        suppressContentEditableWarning
        spellCheck={editing}
        onBlur={(e) => {
          if (!editingRef.current) return;
          setEditing(false);
          callbacks.onStickyTextChange(
            object.id,
            e.currentTarget.textContent ?? "",
          );
        }}
      >
        {getStickyText(object)}
      </div>
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentContent({ object }: { object: CanvasObject }): ReactNode {
  return (
    <div className="canvas-attachment">
      <span className="canvas-attachment-icon">
        <FileText size={20} />
      </span>
      <span className="canvas-attachment-text">
        <span className="canvas-attachment-name">
          {getAttachmentName(object)}
        </span>
        <span className="canvas-attachment-size">
          {formatBytes(getAttachmentSize(object))}
        </span>
      </span>
    </div>
  );
}

function PdfRefContent({ object }: { object: CanvasObject }): ReactNode {
  const ref = getPdfPageReference(object);
  if (ref === null)
    return <div className="canvas-pdf-ref-empty">Invalid page reference</div>;
  return (
    <div className="pdf-ref-block">
      <div className="pdf-ref-header">
        <span>Page {ref.pageNumber}</span>
        <span>
          {describePageReference({
            sourceNoteId: ref.sourceNoteId,
            pageNumber: ref.pageNumber,
          })}
        </span>
      </div>
      <div className="pdf-ref-body">
        <PdfPageView
          pdfUrl={ref.pdfUrl}
          pageNumber={ref.pageNumber - 1}
          targetWidth={Math.max(120, object.bounds.width - 12)}
        />
      </div>
    </div>
  );
}
