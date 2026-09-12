// Offscreen read-only note render for screenshot_note: SVG + HTML objects, tiled PNG capture.
import { createRoot } from "react-dom/client";
import { toPng } from "html-to-image";
import type { CanvasObject, RegionalObjectQueryResponse } from "@aurora/shared";
import { apiPost } from "../../lib/http.js";
import { HtmlObject, SceneObject } from "../canvas/ObjectRenderer.js";
import "../canvas/canvasStyles.css";

const MAX_WIDTH = 1600;
const TILE_HEIGHT = 1600;

const NOOP = {
  onRichTextChange: () => undefined,
  onStickyTextChange: () => undefined,
};

export async function screenshotNote(
  noteId: string,
  tile = 0,
): Promise<{ images: string[]; tileCount: number; truncated: boolean }> {
  const response = await apiPost<RegionalObjectQueryResponse>(
    `/api/notes/${noteId}/objects/query`,
    {
      viewport: {
        x: -1_000_000,
        y: -1_000_000,
        width: 2_000_000,
        height: 2_000_000,
      },
    },
  );
  const objects = response.objects;
  let minX = 0;
  let minY = 0;
  let maxX = 800;
  let maxY = 600;
  if (objects.length > 0) {
    minX = Math.min(...objects.map((object) => object.bounds.x));
    minY = Math.min(...objects.map((object) => object.bounds.y));
    maxX = Math.max(
      ...objects.map((object) => object.bounds.x + object.bounds.width),
    );
    maxY = Math.max(
      ...objects.map((object) => object.bounds.y + object.bounds.height),
    );
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const scale = Math.min(1, MAX_WIDTH / width);
  const renderWidth = Math.ceil(width * scale);
  const renderHeight = Math.ceil(height * scale);
  const tileCount = Math.max(1, Math.ceil(renderHeight / TILE_HEIGHT));
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;pointer-events:none;z-index:-1;";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await new Promise<void>((resolve) => {
      root.render(
        <NoteSnapshotScene
          objects={objects}
          minX={minX}
          minY={minY}
          width={width}
          height={height}
          scale={scale}
          renderWidth={renderWidth}
          renderHeight={renderHeight}
        />,
      );
      window.setTimeout(resolve, 120);
    });
    const scene = host.querySelector(
      ".chat-note-snapshot",
    ) as HTMLElement | null;
    if (!scene) throw new Error("Note snapshot failed to mount");
    const images: string[] = [];
    const y = tile * TILE_HEIGHT;
    const clipHeight = Math.min(TILE_HEIGHT, renderHeight - y);
    const png = await toPng(scene, {
      width: renderWidth,
      height: clipHeight,
      style: {
        transform: `translateY(${-y}px)`,
        transformOrigin: "top left",
      },
      pixelRatio: 1,
    });
    images.push(png);
    return {
      images,
      tileCount,
      truncated: response.truncated || tile + 1 < tileCount,
    };
  } finally {
    root.unmount();
    host.remove();
  }
}

function NoteSnapshotScene({
  objects,
  minX,
  minY,
  width,
  height,
  scale,
  renderWidth,
  renderHeight,
}: {
  objects: CanvasObject[];
  minX: number;
  minY: number;
  width: number;
  height: number;
  scale: number;
  renderWidth: number;
  renderHeight: number;
}) {
  const html = objects.filter((object) =>
    [
      "rich-text",
      "sticky-note",
      "image",
      "attachment",
      "pdf-page-reference",
    ].includes(object.kind),
  );
  const scene = objects.filter((object) => !html.includes(object));
  return (
    <div
      className="chat-note-snapshot"
      style={{
        width: renderWidth,
        height: renderHeight,
        overflow: "hidden",
        background: "#1b1d21",
      }}
    >
      <div
        style={{
          width,
          height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "relative",
        }}
      >
        <svg
          width={width}
          height={height}
          viewBox={`${minX} ${minY} ${width} ${height}`}
          style={{ position: "absolute", inset: 0 }}
        >
          {scene.map((object) => (
            <SceneObject key={object.id} object={object} />
          ))}
        </svg>
        <div
          style={{
            position: "absolute",
            left: -minX,
            top: -minY,
            width,
            height,
          }}
        >
          {html.map((object) => (
            <HtmlObject
              key={object.id}
              object={object}
              interactive={false}
              selected={false}
              callbacks={NOOP}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
