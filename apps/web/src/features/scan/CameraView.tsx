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
import { analysisBitmap, canvasToJpeg, type Capture } from "./capture";
import type { Point, Quad } from "./quadGeometry";
import { detectFrame } from "./scanner";
import { useCamera } from "./useCamera";

/** Preview frames are analyzed at this size: enough to find edges, cheap to transfer. */
const FRAME_SIDE = 480;
/** Frames without a detection before the outline disappears, so one miss does not flicker. */
const MISSES_BEFORE_HIDE = 3;
/** Share of the remaining distance the outline moves each display frame. */
const OUTLINE_EASING = 0.35;
/** A detection farther than this from the shown outline replaces it outright. */
const OUTLINE_JUMP = 0.15;
/** Tapping this close to the current hint clears it. */
const HINT_CLEAR_DISTANCE = 0.05;

function nextVideoFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if ("requestVideoFrameCallback" in video)
      video.requestVideoFrameCallback(() => resolve());
    else requestAnimationFrame(() => resolve());
  });
}

/**
 * Detects the document in preview frames, one at a time and back to back, and
 * eases the outline toward each result on every display frame. The outline is
 * drawn by writing the SVG directly, so the viewfinder never waits on React or
 * on detection. Returns whether an outline is showing.
 */
function useLiveOutline(
  video: React.RefObject<HTMLVideoElement | null>,
  polygon: React.RefObject<SVGPolygonElement | null>,
  shown: React.RefObject<Quad | null>,
  hint: React.RefObject<Point | null>,
  active: boolean,
): boolean {
  const [found, setFound] = useState(false);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let target: Quad | null = null;
    let misses = 0;

    void (async () => {
      while (!stopped) {
        const element = video.current;
        if (!element || element.videoWidth === 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        await nextVideoFrame(element);
        const quad = await analysisBitmap(element, FRAME_SIDE)
          .then((frame) => detectFrame(frame, hint.current ?? undefined))
          .catch(() => null);
        if (stopped) return;
        misses = quad ? 0 : misses + 1;
        if (quad) target = quad;
        else if (misses >= MISSES_BEFORE_HIDE) target = null;
        setFound(target !== null);
      }
    })();

    let frame = requestAnimationFrame(function draw() {
      const current = shown.current;
      if (!target) shown.current = null;
      else if (
        !current ||
        target.some(
          (p, i) =>
            Math.hypot(p.x - current[i]!.x, p.y - current[i]!.y) > OUTLINE_JUMP,
        )
      )
        shown.current = target;
      else
        shown.current = current.map((p, i) => ({
          x: p.x + (target![i]!.x - p.x) * OUTLINE_EASING,
          y: p.y + (target![i]!.y - p.y) * OUTLINE_EASING,
        })) as Quad;
      const element = polygon.current;
      if (element) {
        const quad = shown.current;
        element.style.visibility = quad ? "visible" : "hidden";
        if (quad)
          element.setAttribute(
            "points",
            quad.map((p) => `${p.x},${p.y}`).join(" "),
          );
      }
      frame = requestAnimationFrame(draw);
    });

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      shown.current = null;
      setFound(false);
    };
  }, [active, video, polygon, shown, hint]);
  return found;
}

export function CameraView({
  active,
  scannerReady,
  onCapture,
  onFile,
  onClose,
}: {
  /** False while a capture is reviewed; the camera keeps running so a still can finish and retakes start at once. */
  active: boolean;
  scannerReady: boolean;
  onCapture: (capture: Capture) => void;
  onFile: (file: File) => void;
  onClose: () => void;
}): ReactNode {
  const video = useRef<HTMLVideoElement | null>(null);
  const polygon = useRef<SVGPolygonElement | null>(null);
  const shown = useRef<Quad | null>(null);
  const hintRef = useRef<Point | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const camera = useCamera(video);
  const live = camera.state.status === "live";
  const [hint, setHint] = useState<Point | null>(null);
  hintRef.current = hint;
  const found = useLiveOutline(
    video,
    polygon,
    shown,
    hintRef,
    active && live && scannerReady,
  );
  const [aspect, setAspect] = useState(3 / 4);
  const [focus, setFocus] = useState<Point | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const controls =
    camera.state.status === "live" ? camera.state.controls : null;

  useEffect(() => {
    if (!focus) return;
    const timer = setTimeout(() => setFocus(null), 900);
    return () => clearTimeout(timer);
  }, [focus]);

  // A hidden video can pause; resume it when the viewfinder comes back.
  useEffect(() => {
    if (active && video.current?.paused)
      void video.current.play().catch(() => undefined);
  }, [active]);

  /** Hands over the frame on screen now; the full-resolution still follows. */
  const shoot = (): void => {
    setCaptureError(null);
    let picture: HTMLCanvasElement;
    try {
      picture = camera.grabFrame();
    } catch (error) {
      setCaptureError(
        error instanceof Error ? error.message : "Could not take the photo",
      );
      return;
    }
    onCapture({
      picture,
      photo: camera.takePhoto().catch(() => canvasToJpeg(picture)),
      outline: shown.current,
      hint,
    });
  };

  const tap = (event: React.MouseEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const point = {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
    if (
      hint &&
      Math.hypot(point.x - hint.x, point.y - hint.y) < HINT_CLEAR_DISTANCE
    ) {
      setHint(null);
      return;
    }
    setHint(point);
    if (controls?.canFocus) {
      camera.focusAt(point);
      setFocus(point);
    }
  };

  const status = !live
    ? null
    : captureError
      ? captureError
      : !scannerReady
        ? "Loading scanner…"
        : found
          ? null
          : hint
            ? "Looking around the tapped spot"
            : "Point at a slide, page, or board. Tap it to help.";

  return (
    <div className="scan-screen" hidden={!active}>
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
            onClick={tap}
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
            <svg
              className="scan-outline"
              viewBox="0 0 1 1"
              preserveAspectRatio="none"
              aria-hidden
            >
              <polygon
                ref={polygon}
                style={{ visibility: "hidden" }}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {hint ? (
              <span
                className="scan-hint-marker"
                style={{ left: `${hint.x * 100}%`, top: `${hint.y * 100}%` }}
              />
            ) : null}
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
          disabled={!live}
          onClick={shoot}
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
            if (file) onFile(file);
          }}
        />
      </div>
    </div>
  );
}
