// This component hosts the canvas feature for the selected note. It bridges the
// canvas to the sync layer: editing operations flow through enqueueObjectMutation
// (durable outbox + local cache) and the note's canvas mode comes from the library
// cache. Viewport rendering, modes, culling, and object editing stay in the canvas.
import { useCallback, useRef } from "react";
import { CanvasWorkspace } from "../features/canvas";
import type { SyncOperation } from "@aurora/shared";
import type { CanvasMode } from "@aurora/shared";
import { enqueueObjectMutation } from "../sync/outbox.js";

export function MainEditor({
  ownerId,
  noteId,
  canvasMode,
}: {
  ownerId: string;
  noteId: string;
  canvasMode: CanvasMode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Every coalesced canvas operation enters the durable outbox; the upserted
  // object is already the local cache version, so acknowledgements can advance
  // revisions locally once the server responds.
  const handleOperation = useCallback((operation: SyncOperation) => {
    void enqueueObjectMutation({
      op: operation,
      ...(operation.mutation.type === "upsert"
        ? { upsertedObject: operation.mutation.object }
        : {}),
    });
  }, []);

  return (
    <div className="canvas-area" ref={containerRef}>
      <CanvasWorkspace
        ownerId={ownerId}
        noteId={noteId}
        mode={canvasMode}
        onOperation={handleOperation}
      />
    </div>
  );
}
