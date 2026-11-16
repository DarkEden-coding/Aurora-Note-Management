// Live viewfinder: shows the camera with the detected document outlined, the device's camera controls, a shutter, and a way out to the native camera app or a saved photo.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Flashlight,
  FlashlightOff,
  ImagePlus,
  Sun,
  X,
  ZoomIn,
} from "lucide-react";
import { detectFrame } from "./scanner";
import { QuadOutline } from "./QuadOutline";
import type { Point, Quad } from "./quadGeometry";
import { useCamera } from "./useCamera";

/** Preview frames are analyzed at this size: enough to find edges, cheap to transfer. */
const FRAME_SIDE = 480;
const FRAME_INTERVAL_MS = 120;
/** Frames without a detection before the outline disappears, so one miss does not flicker. */
const MISSES_BEFORE_HIDE = 3;

/** Blends toward a nearby detection to steady the outline; jumps to a distant one. */
function steady(previous: Quad | null, next: Quad): Quad {
  if (!previous) return next;
  const far = next.some(
    (p, i) => Math.hypot(p.x - previous[i]!.x, p.y - previous[i]!.y) > 0.05,
  );
  if (far) return next;
  return next.map((p, i) => ({
    x: (p.x + previous[i]!.x) / 2,
    y: (p.y + previous[i]!.y) / 2,
  })) as Quad;
}

function useLiveOutline(
  video: React.RefObject<HTMLVideoElement | null>,
  active: boolean,
): Quad | null {
  const [outline, setOutline] = useState<Quad | null>(null);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let misses = 0;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    void (async () => {
      while (!stopped) {
        const element = video.current;
        if (element && element.videoWidth > 0) {
          const scale = Math.min(
            1,
            FRAME_SIDE / Math.max(element.videoWidth, element.videoHeight),
          );
          canvas.width = Math.round(element.videoWidth * scale);
          canvas.height = Math.round(element.videoHeight * scale);
          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          const quad = await detectFrame(
            context.getImageData(0, 0, canvas.width, canvas.height),
          ).catch(() => null);
          if (stopped) return;
          misses = quad ? 0 : misses + 1;
          setOutline((previous) =>
            quad
              ? steady(previous, quad)
              : misses >= MISSES_BEFORE_HIDE
                ? null
                : previous,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, FRAME_INTERVAL_MS));
      }
    })();
    return () => {
      stopped = true;
    };
  }, [active, video]);
  return outline;
}

export function CameraView({
  scannerReady,
  onPhoto,
  onClose,
}: {
  scannerReady: boolean;
  onPhoto: (photo: Blob) => void;
  onClose: () => void;
}): ReactNode {
  const video = useRef<HTMLVideoElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const camera = useCamera(video);
  const live = camera.state.status === "live";
  const outline = useLiveOutline(video, live && scannerReady);
  const [aspect, setAspect] = useState(3 / 4);
  const [focus, setFocus] = useState<Point | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const controls =
    camera.state.status === "live" ? camera.state.controls : null;

  useEffect(() => {
    if (!focus) return;
    const timer = setTimeout(() => setFocus(null), 900);
    return () => clearTimeout(timer);
  }, [focus]);

  const shoot = async (): Promise<void> => {
    setCapturing(true);
    setCaptureError(null);
    try {
      onPhoto(await camera.takePhoto());
    } catch (error) {
      setCaptureError(
        error instanceof Error ? error.message : "Could not take the photo",
      );
    } finally {
      setCapturing(false);
    }
  };

  const status = !live
    ? null
    : captureError
      ? captureError
      : !scannerReady
        ? "Loading scanner…"
        : outline
          ? null
          : "Point at a slide, page, or board";

  return (
    <>
      <div className="scan-topbar">
        <button
          type="button"
          className="scan-icon-button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        {controls?.torch !== null && controls?.torch !== undefined ? (
          <button
            type="button"
            className="scan-icon-button"
            aria-label={controls.torch ? "Turn light off" : "Turn light on"}
            aria-pressed={controls.torch}
            title="Light"
            onClick={camera.toggleTorch}
          >
            {controls.torch ? (
              <Flashlight size={20} />
            ) : (
              <FlashlightOff size={20} />
            )}
          </button>
        ) : null}
      </div>

      <div className="scan-stage-area">
        {camera.state.status === "error" ? (
          <div className="scan-message">
            <p>{camera.state.message}</p>
            <p>You can still scan a photo taken with the camera app.</p>
          </div>
        ) : (
          <div
            className="scan-stage"
            style={{ "--scan-aspect": aspect } as React.CSSProperties}
            onClick={(event) => {
              if (!controls?.canFocus) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const point = {
                x: (event.clientX - rect.left) / rect.width,
                y: (event.clientY - rect.top) / rect.height,
              };
              camera.focusAt(point);
              setFocus(point);
            }}
          >
            <video
              ref={video}
              className="scan-media"
              playsInline
              muted
              onLoadedMetadata={(event) => {
                const { videoWidth, videoHeight } = event.currentTarget;
                if (videoWidth > 0 && videoHeight > 0)
                  setAspect(videoWidth / videoHeight);
              }}
            />
            {outline ? <QuadOutline quad={outline} /> : null}
            {focus ? (
              <span
                className="scan-focus-ring"
                style={{ left: `${focus.x * 100}%`, top: `${focus.y * 100}%` }}
              />
            ) : null}
            {status ? <div className="scan-hint">{status}</div> : null}
          </div>
        )}
      </div>

      {controls?.zoom || controls?.exposure ? (
        <div className="scan-sliders">
          {controls.zoom ? (
            <label className="scan-slider">
              <ZoomIn size={16} aria-hidden />
              <span className="scan-visually-hidden">Zoom</span>
              <input
                type="range"
                min={controls.zoom.min}
                max={controls.zoom.max}
                step={controls.zoom.step || 0.1}
                value={controls.zoom.value}
                onChange={(event) =>
                  camera.setZoom(Number(event.currentTarget.value))
                }
              />
              <output>{controls.zoom.value.toFixed(1)}×</output>
            </label>
          ) : null}
          {controls.exposure ? (
            <label className="scan-slider">
              <Sun size={16} aria-hidden />
              <span className="scan-visually-hidden">Exposure</span>
              <input
                type="range"
                min={controls.exposure.min}
                max={controls.exposure.max}
                step={controls.exposure.step || 0.1}
                value={controls.exposure.value}
                onChange={(event) =>
                  camera.setExposure(Number(event.currentTarget.value))
                }
              />
              <output>
                {controls.exposure.value > 0 ? "+" : ""}
                {controls.exposure.value.toFixed(1)}
              </output>
            </label>
          ) : null}
        </div>
      ) : null}

      <div className="scan-bottombar">
        <button
          type="button"
          className="scan-icon-button"
          aria-label="Use the camera app or a saved photo"
          title="Use the camera app or a saved photo"
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus size={22} />
        </button>
        <button
          type="button"
          className="scan-shutter"
          aria-label="Take photo"
          disabled={!live || capturing}
          onClick={() => void shoot()}
        />
        <span className="scan-bottombar-spacer" />
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) onPhoto(file);
          }}
        />
      </div>
    </>
  );
}
