// Full-screen scan flow: capture a photo, review the detected corners, then hand back the flattened image as a JPEG file.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CameraView } from "./CameraView";
import { CornerReview } from "./CornerReview";
import type { Quad } from "./quadGeometry";
import { detectPhoto, flattenPhoto, warmUpScanner } from "./scanner";
import "./scanStyles.css";

type Phase =
  | { kind: "camera" }
  | {
      kind: "review";
      photo: Blob;
      url: string;
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
  const [phase, setPhase] = useState<Phase>({ kind: "camera" });
  const [scanner, setScanner] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [busy, setBusy] = useState(false);
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

  const reviewUrl = phase.kind === "review" ? phase.url : null;
  useEffect(() => {
    if (!reviewUrl) return;
    return () => URL.revokeObjectURL(reviewUrl);
  }, [reviewUrl]);

  const review = (photo: Blob): void => {
    const url = URL.createObjectURL(photo);
    setError(null);
    setPhase({ kind: "review", photo, url, detected: undefined });
    const settle = (detected: Quad | null): void =>
      setPhase((current) =>
        current.kind === "review" && current.url === url
          ? { ...current, detected }
          : current,
      );
    detectPhoto(photo).then(settle, () => settle(null));
  };

  const insert = async (photo: Blob, quad: Quad): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const jpeg = await flattenPhoto(photo, quad);
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
      {phase.kind === "camera" ? (
        <CameraView
          scannerReady={scanner === "ready"}
          onPhoto={review}
          onClose={onClose}
        />
      ) : (
        <CornerReview
          key={phase.url}
          photoUrl={phase.url}
          detected={phase.detected}
          busy={busy}
          onRetake={() => setPhase({ kind: "camera" })}
          onInsert={(quad) => void insert(phase.photo, quad)}
        />
      )}
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
