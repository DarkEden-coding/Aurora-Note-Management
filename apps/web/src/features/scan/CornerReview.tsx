// Review step: the captured photo with the four corners to crop to. Corners can be dragged; a loupe magnifies the spot under the finger.
import { useRef, useState, type ReactNode } from "react";
import { Check, Expand, RotateCcw, WandSparkles } from "lucide-react";
import { QuadOutline } from "./QuadOutline";
import { isConvexQuad, type Quad } from "./quadGeometry";

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
  photoUrl,
  detected,
  busy,
  onRetake,
  onInsert,
}: {
  photoUrl: string;
  /** Detected corners; undefined while detection runs, null when nothing was found. */
  detected: Quad | null | undefined;
  busy: boolean;
  onRetake: () => void;
  onInsert: (quad: Quad) => void;
}): ReactNode {
  const [aspect, setAspect] = useState<number | null>(null);
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

  return (
    <>
      <div className="scan-topbar">
        <span className="scan-title">
          {finding
            ? "Finding edges…"
            : detected === null && edited === null
              ? "No edges found. Drag the corners."
              : "Drag the corners to adjust"}
        </span>
      </div>

      <div className="scan-stage-area">
        <div
          ref={stage}
          className="scan-stage"
          style={
            aspect
              ? ({ "--scan-aspect": aspect } as React.CSSProperties)
              : { visibility: "hidden" }
          }
        >
          <img
            className="scan-media"
            src={photoUrl}
            alt="Captured photo"
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              setAspect(naturalWidth / naturalHeight);
            }}
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
              style={{
                width: LOUPE_SIZE,
                height: LOUPE_SIZE,
                backgroundImage: `url("${photoUrl}")`,
                backgroundSize: `${drag.stage.width * LOUPE_ZOOM}px ${drag.stage.height * LOUPE_ZOOM}px`,
                backgroundPosition: `${LOUPE_SIZE / 2 - dragged.x * drag.stage.width * LOUPE_ZOOM}px ${
                  LOUPE_SIZE / 2 - dragged.y * drag.stage.height * LOUPE_ZOOM
                }px`,
              }}
            />
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
