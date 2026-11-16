// Rear-camera stream for the scanner viewfinder, with the hardware controls the device exposes (zoom, torch, exposure, tap to focus) and full-resolution stills.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { Point } from "./quadGeometry";

interface Range {
  min: number;
  max: number;
  step: number;
}

/** Image Capture extensions to track capabilities; absent from TypeScript's DOM types. */
interface CameraCapabilities extends MediaTrackCapabilities {
  zoom?: Range;
  torch?: boolean;
  exposureCompensation?: Range;
  focusMode?: string[];
}

interface CameraSettings extends MediaTrackSettings {
  zoom?: number;
  exposureCompensation?: number;
}

interface CameraConstraint {
  zoom?: number;
  torch?: boolean;
  exposureCompensation?: number;
  focusMode?: string;
  pointsOfInterest?: Point[];
}

interface PhotoCapabilities {
  imageWidth?: Range;
  imageHeight?: Range;
}

interface ImageCaptureLike {
  getPhotoCapabilities(): Promise<PhotoCapabilities>;
  takePhoto(settings?: {
    imageWidth?: number;
    imageHeight?: number;
  }): Promise<Blob>;
}

declare const ImageCapture:
  { new (track: MediaStreamTrack): ImageCaptureLike } | undefined;

export interface CameraControls {
  zoom: (Range & { value: number }) | null;
  exposure: (Range & { value: number }) | null;
  torch: boolean | null;
  canFocus: boolean;
}

export type CameraState =
  | { status: "starting" }
  | { status: "live"; controls: CameraControls }
  | { status: "error"; message: string };

function describeError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError")
      return "Camera access is blocked. Allow it in the browser's site settings.";
    if (error.name === "NotFoundError")
      return "No camera was found on this device.";
    if (error.name === "NotReadableError")
      return "The camera is in use by another app.";
  }
  return "The camera could not start.";
}

function readControls(track: MediaStreamTrack): CameraControls {
  const capabilities = (track.getCapabilities?.() ?? {}) as CameraCapabilities;
  const settings = track.getSettings() as CameraSettings;
  const supported = navigator.mediaDevices.getSupportedConstraints() as Record<
    string,
    boolean
  >;
  const range = (r: Range | undefined, value: number | undefined) =>
    r && r.max > r.min ? { ...r, value: value ?? r.min } : null;
  return {
    zoom: range(capabilities.zoom, settings.zoom),
    exposure: range(
      capabilities.exposureCompensation,
      settings.exposureCompensation,
    ),
    torch: capabilities.torch ? false : null,
    canFocus: supported.pointsOfInterest === true,
  };
}

export function useCamera(video: RefObject<HTMLVideoElement | null>): {
  state: CameraState;
  setZoom: (value: number) => void;
  setExposure: (value: number) => void;
  toggleTorch: () => void;
  focusAt: (point: Point) => void;
  grabFrame: () => HTMLCanvasElement;
  takePhoto: () => Promise<Blob>;
} {
  const [state, setState] = useState<CameraState>({ status: "starting" });
  const trackRef = useRef<MediaStreamTrack | null>(null);
  /** Still capture prepared when the stream starts, so the shutter does not wait on setup. */
  const stillRef = useRef<{
    capture: ImageCaptureLike;
    size: Promise<{ imageWidth?: number; imageHeight?: number }>;
  } | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            // 4:3 matches the sensor, so the preview shows what the still captures.
            width: { ideal: 1920 },
            height: { ideal: 1440 },
            aspectRatio: { ideal: 4 / 3 },
          },
        });
        if (cancelled) return;
        const track = stream.getVideoTracks()[0]!;
        trackRef.current = track;
        if (typeof ImageCapture !== "undefined") {
          try {
            const capture = new ImageCapture(track);
            stillRef.current = {
              capture,
              size: capture
                .getPhotoCapabilities()
                .then((photo) => ({
                  ...(photo.imageWidth
                    ? { imageWidth: photo.imageWidth.max }
                    : {}),
                  ...(photo.imageHeight
                    ? { imageHeight: photo.imageHeight.max }
                    : {}),
                }))
                .catch(() => ({})),
            };
          } catch {
            stillRef.current = null;
          }
        }
        const capabilities = (track.getCapabilities?.() ??
          {}) as CameraCapabilities;
        if (capabilities.focusMode?.includes("continuous"))
          await track
            .applyConstraints({
              advanced: [
                { focusMode: "continuous" } as MediaTrackConstraintSet,
              ],
            })
            .catch(() => undefined);
        const element = video.current;
        if (element) {
          element.srcObject = stream;
          await element.play();
        }
        if (!cancelled)
          setState({ status: "live", controls: readControls(track) });
      } catch (error) {
        if (!cancelled)
          setState({ status: "error", message: describeError(error) });
      }
    })();
    return () => {
      cancelled = true;
      trackRef.current = null;
      stillRef.current = null;
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [video]);

  const apply = useCallback((constraint: CameraConstraint): void => {
    const track = trackRef.current;
    if (!track) return;
    void track
      .applyConstraints({ advanced: [constraint as MediaTrackConstraintSet] })
      .catch(() => undefined);
  }, []);

  const updateControls = useCallback(
    (patch: (controls: CameraControls) => CameraControls): void => {
      setState((current) =>
        current.status === "live"
          ? { ...current, controls: patch(current.controls) }
          : current,
      );
    },
    [],
  );

  const setZoom = useCallback(
    (value: number): void => {
      apply({ zoom: value });
      updateControls((c) =>
        c.zoom ? { ...c, zoom: { ...c.zoom, value } } : c,
      );
    },
    [apply, updateControls],
  );

  const setExposure = useCallback(
    (value: number): void => {
      apply({ exposureCompensation: value });
      updateControls((c) =>
        c.exposure ? { ...c, exposure: { ...c.exposure, value } } : c,
      );
    },
    [apply, updateControls],
  );

  const torch = state.status === "live" ? state.controls.torch : null;
  const toggleTorch = useCallback((): void => {
    if (torch === null) return;
    apply({ torch: !torch });
    updateControls((c) => ({ ...c, torch: !torch }));
  }, [apply, torch, updateControls]);

  /** Focuses and meters on a point given in normalized frame coordinates. */
  const focusAt = useCallback(
    (point: Point): void => apply({ pointsOfInterest: [point] }),
    [apply],
  );

  /** The frame on screen right now, copied at once so the shutter feels instant. */
  const grabFrame = useCallback((): HTMLCanvasElement => {
    const element = video.current;
    if (!element || element.videoWidth === 0)
      throw new Error("The camera is not running");
    const canvas = document.createElement("canvas");
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    canvas.getContext("2d")!.drawImage(element, 0, 0);
    return canvas;
  }, [video]);

  /**
   * A full-resolution still where the browser supports it (Chrome); rejects
   * otherwise, and callers fall back to the grabbed frame. It may take a
   * second, so start it right after grabbing the frame.
   */
  const takePhoto = useCallback(async (): Promise<Blob> => {
    const still = stillRef.current;
    if (!still) throw new Error("Still capture is not supported");
    try {
      return await still.capture.takePhoto(await still.size);
    } catch {
      // Some cameras reject an explicit size; their default is usually full resolution too.
      return still.capture.takePhoto();
    }
  }, []);

  return {
    state,
    setZoom,
    setExposure,
    toggleTorch,
    focusAt,
    grabFrame,
    takePhoto,
  };
}
