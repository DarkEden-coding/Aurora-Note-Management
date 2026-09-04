// This component hosts the canvas feature for the selected note. It bridges the
// canvas to the sync layer: editing operations flow through enqueueObjectMutation
// (durable outbox + local cache) and the note's canvas mode comes from the library
// cache. Viewport rendering, modes, culling, and object editing stay in the canvas.
import { useCallback, useRef, useState } from "react";
import { CanvasWorkspace } from "../features/canvas";
import type { SyncOperation } from "@aurora/shared";
import type { Background, CanvasMode, DrawingPalette } from "@aurora/shared";
import { syncEngine } from "../sync/engine.js";
import { enqueueObjectMutation } from "../sync/outbox.js";

export function MainEditor({
  ownerId,
  noteId,
  canvasMode,
  background,
  drawingPalette,
  onDrawingPaletteChange,
}: {
  ownerId: string;
  noteId: string;
  canvasMode: CanvasMode;
  background: Background;
  drawingPalette: DrawingPalette;
  onDrawingPaletteChange: (drawingPalette: DrawingPalette) => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  // Every coalesced canvas operation enters the durable outbox; the upserted
  // object is already the local cache version, so acknowledgements can advance
  // revisions locally once the server responds.
  const handleOperation = useCallback((operation: SyncOperation) => {
    void enqueueObjectMutation({
      op: operation,
      ...(operation.mutation.type === "upsert"
        ? { upsertedObject: operation.mutation.object }
        : {}),
    })
      .then(() => {
        setPersistenceError(null);
        syncEngine.requestFlush();
      })
      .catch((error: unknown) => {
        setPersistenceError(
          error instanceof Error
            ? `Could not save this edit offline: ${error.message}`
            : "Could not save this edit offline",
        );
      });
  }, []);

  return (
    <div className="canvas-area" ref={containerRef}>
      {persistenceError ? (
        <button
          type="button"
          className="canvas-import-error"
          role="alert"
          onClick={() => setPersistenceError(null)}
        >
          {persistenceError}
        </button>
      ) : null}
      <CanvasWorkspace
        ownerId={ownerId}
        noteId={noteId}
        mode={canvasMode}
        background={background}
        drawingPalette={drawingPalette}
        onDrawingPaletteChange={onDrawingPaletteChange}
        onOperation={handleOperation}
      />
    </div>
  );
}
