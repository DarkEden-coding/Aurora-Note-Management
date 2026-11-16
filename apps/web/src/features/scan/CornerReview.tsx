// Review step: the captured photo with the four corners to crop to. Corners can be dragged, with a loupe magnifying the spot under the finger; tapping the photo finds the edges around that spot.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Expand, RotateCcw, WandSparkles } from "lucide-react";
import { QuadOutline } from "./QuadOutline";
import { isConvexQuad, type Point, type Quad } from "./quadGeometry";

const FULL_PHOTO: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const CORNER_NAMES = ["top-left", "top-right", "bottom-right", "bottom-left"];
const LOUPE_SIZE = 120;
const LOUPE_ZOOM = 3;

interface Drag {
  corner: number;
  stage: DOMRect;
}

export function CornerReview({
  picture,
  detected,
  busy,
  onRetake,
  onFind,
  onInsert,
}: {
  picture: HTMLCanvasElement;
  /** Detected corners; undefined while detection runs, null when nothing was found. */
  detected: Quad | null | undefined;
  busy: boolean;
  onRetake: () => void;
  /** Detect again, preferring quads around this spot. */
  onFind: (hint: Point) => void;
  onInsert: (quad: Quad) => void;
}): ReactNode {
  const aspect = picture.width / picture.height;
  const shown = useRef<HTMLCanvasElement | null>(null);
  const loupe = useRef<HTMLCanvasElement | null>(null);
  const [edited, setEdited] = useState<Quad | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const corners = edited ?? detected ?? FULL_PHOTO;
  const convex = isConvexQuad(corners);
  const finding = detected === undefined;

  const moveCorner = (
    corner: number,
    clientX: number,
    clientY: number,
    rect: DOMRect,
  ): void => {
    const point = {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
    setEdited(corners.map((p, i) => (i === corner ? point : p)) as Quad);
  };

  const dragged = drag ? corners[drag.corner]! : null;
  const loupeOnRight = dragged !== null && dragged.x < 0.5 && dragged.y < 0.35;

  useLayoutEffect(() => {
    shown.current?.getContext("2d")?.drawImage(picture, 0, 0);
  }, [picture]);

  // Redraw the loupe as the corner moves.
  useLayoutEffect(() => {
    const canvas = loupe.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !drag || !dragged) return;
    // The picture region that fills the loupe at LOUPE_ZOOM× the on-screen size.
    const span = (LOUPE_SIZE / (drag.stage.width * LOUPE_ZOOM)) * picture.width;
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      picture,
      dragged.x * picture.width - span / 2,
      dragged.y * picture.height - span / 2,
      span,
      span,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }, [drag, dragged, picture]);

  return (
    <>
      <div className="scan-topbar">
        <span className="scan-title">
          {finding
            ? "Finding edges…"
            : detected === null && edited === null
              ? "No edges found. Tap the subject or drag the corners."
              : "Drag the corners, or tap the subject"}
        </span>
      </div>

      <div className="scan-stage-area">
        <div
          ref={stage}
          className="scan-stage"
          style={{ "--scan-aspect": aspect } as React.CSSProperties}
          onClick={(event) => {
            // Taps on the corner handles are drags, not requests to search.
            if (busy || event.target instanceof HTMLButtonElement) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setEdited(null);
            onFind({
              x: (event.clientX - rect.left) / rect.width,
              y: (event.clientY - rect.top) / rect.height,
            });
          }}
        >
          <canvas
            ref={shown}
            className="scan-media"
            width={picture.width}
            height={picture.height}
            role="img"
            aria-label="Captured photo"
          />
          {finding ? null : (
            <>
              <QuadOutline quad={corners} invalid={!convex} />
              {corners.map((p, i) => (
                <button
                  key={CORNER_NAMES[i]}
                  type="button"
                  className="scan-handle"
                  aria-label={`Move ${CORNER_NAMES[i]} corner`}
                  data-dragging={drag?.corner === i ? "true" : "false"}
                  style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                  onPointerDown={(event) => {
                    if (!stage.current) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDrag({
                      corner: i,
                      stage: stage.current.getBoundingClientRect(),
                    });
                  }}
                  onPointerMove={(event) => {
                    if (drag?.corner === i)
                      moveCorner(i, event.clientX, event.clientY, drag.stage);
                  }}
                  onPointerUp={() => setDrag(null)}
                  onPointerCancel={() => setDrag(null)}
                />
              ))}
            </>
          )}
          {drag && dragged ? (
            <div
              className="scan-loupe"
              data-side={loupeOnRight ? "right" : "left"}
              style={{ width: LOUPE_SIZE, height: LOUPE_SIZE }}
            >
              <canvas
                ref={loupe}
                width={LOUPE_SIZE * Math.ceil(window.devicePixelRatio || 1)}
                height={LOUPE_SIZE * Math.ceil(window.devicePixelRatio || 1)}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="scan-bottombar">
        <button
          type="button"
          className="scan-text-button"
          onClick={onRetake}
          disabled={busy}
        >
          <RotateCcw size={18} /> Retake
        </button>
        <div className="scan-review-tools">
          <button
            type="button"
            className="scan-icon-button"
            aria-label="Use detected edges"
            title="Use detected edges"
            disabled={!detected || edited === null || busy}
            onClick={() => setEdited(null)}
          >
            <WandSparkles size={20} />
          </button>
          <button
            type="button"
            className="scan-icon-button"
            aria-label="Use the whole photo"
            title="Use the whole photo"
            disabled={busy}
            onClick={() => setEdited(FULL_PHOTO)}
          >
            <Expand size={20} />
          </button>
        </div>
        <button
          type="button"
          className="scan-text-button"
          data-primary="true"
          disabled={finding || !convex || busy}
          onClick={() => onInsert(corners)}
        >
          <Check size={18} /> {busy ? "Inserting…" : "Insert"}
        </button>
      </div>
    </>
  );
}
