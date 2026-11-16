// Full-screen scan flow: capture a photo, review the detected corners, then hand back the flattened image as a JPEG file.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CameraView } from "./CameraView";
import {
  analysisBitmap,
  canvasToJpeg,
  captureFromFile,
  type Capture,
} from "./capture";
import { CornerReview } from "./CornerReview";
import type { Point, Quad } from "./quadGeometry";
import { detectFrame, flattenPhoto, warmUpScanner } from "./scanner";
import "./scanStyles.css";

/** Captured pictures are analyzed at this size. */
const ANALYSIS_SIDE = 1024;

type Review = Capture & {
  /** Distinguishes captures, so the review screen starts fresh for each. */
  id: number;
  /** Detected corners; undefined while detection runs, null when nothing was found. */
  detected: Quad | null | undefined;
};

function scanFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `scan-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}.jpg`;
}

export function ScanDialog({
  onScanned,
  onClose,
}: {
  onScanned: (file: File) => void;
  onClose: () => void;
}): ReactNode {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [scanner, setScanner] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [busy, setBusy] = useState(false);
  const captures = useRef(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
    let cancelled = false;
    warmUpScanner().then(
      () => !cancelled && setScanner("ready"),
      () => !cancelled && setScanner("failed"),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Finds the corners in the reviewed picture, around `hint` when given.
   * Keeps the earlier corners when nothing turns up.
   */
  const detect = (picture: HTMLCanvasElement, hint: Point | null): void => {
    let previous: Quad | null | undefined;
    setReview((current) => {
      if (current?.picture !== picture) return current;
      previous = current.detected;
      return { ...current, detected: undefined };
    });
    const settle = (detected: Quad | null): void =>
      setReview((current) =>
        current?.picture === picture
          ? { ...current, detected: detected ?? previous ?? null }
          : current,
      );
    analysisBitmap(picture, ANALYSIS_SIDE)
      .then((frame) => detectFrame(frame, hint ?? undefined))
      .then(settle, () => settle(null));
  };

  const startReview = (capture: Capture): void => {
    setError(null);
    // The live outline stands in until detection on the still picture finishes.
    captures.current += 1;
    setReview({
      ...capture,
      id: captures.current,
      detected: capture.outline ?? undefined,
    });
    const settle = (detected: Quad | null): void =>
      setReview((current) =>
        current?.picture === capture.picture
          ? { ...current, detected: detected ?? current.detected ?? null }
          : current,
      );
    analysisBitmap(capture.picture, ANALYSIS_SIDE)
      .then((frame) => detectFrame(frame, capture.hint ?? undefined))
      .then(settle, () => settle(null));
  };

  const insert = async (capture: Capture, quad: Quad): Promise<void> => {
    setBusy(true);
    setError(null);
    const viewAspect = capture.picture.width / capture.picture.height;
    try {
      let jpeg: Blob;
      try {
        jpeg = await flattenPhoto(await capture.photo, quad, viewAspect);
      } catch {
        // A still that came back turned or unreadable; use the frame on screen.
        jpeg = await flattenPhoto(
          await canvasToJpeg(capture.picture),
          quad,
          viewAspect,
        );
      }
      onScanned(
        new File([jpeg], scanFileName(new Date()), { type: "image/jpeg" }),
      );
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not flatten the photo",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="scan-dialog"
      aria-label="Scan with camera"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      // Keep keys away from the canvas shortcuts behind the dialog (Backspace deletes the selection).
      onKeyDown={(event) => event.stopPropagation()}
    >
      <CameraView
        active={review === null}
        scannerReady={scanner === "ready"}
        onCapture={startReview}
        onFile={(file) => {
          captureFromFile(file).then(startReview, () =>
            setError("Could not open that photo"),
          );
        }}
        onClose={onClose}
      />
      {review ? (
        <CornerReview
          key={review.id}
          picture={review.picture}
          detected={review.detected}
          busy={busy}
          onRetake={() => setReview(null)}
          onFind={(hint) => detect(review.picture, hint)}
          onInsert={(quad) => void insert(review, quad)}
        />
      ) : null}
      {scanner === "failed" ? (
        <p className="scan-error" role="alert">
          The scanner could not load, so edges cannot be found or flattened.
        </p>
      ) : error ? (
        <p className="scan-error" role="alert">
          {error}
        </p>
      ) : null}
    </dialog>
  );
}
