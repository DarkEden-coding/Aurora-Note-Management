// This component hosts the canvas feature for the selected note. It bridges the
// canvas to the sync layer: editing operations flow through enqueueObjectMutations
// (durable outbox + local cache) and the note's canvas mode comes from the library
// cache. Viewport rendering, modes, culling, and object editing stay in the canvas.
// When the note has a practice session, the practice bar sits below the canvas
// and the canvas follows the session to its newest page.
import { useCallback, useRef, useState } from "react";
import { CanvasWorkspace } from "../features/canvas";
import {
  PracticeBar,
  focusPageIndex,
  usePracticeSession,
} from "../features/practice";
import type { SyncOperation } from "@aurora/shared";
import type { Background, CanvasMode, DrawingPalette } from "@aurora/shared";
import { syncEngine } from "../sync/engine.js";
import { enqueueObjectMutations } from "../sync/outbox.js";
import { useLibrary } from "../features/library/LibraryContext.js";

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
  const library = useLibrary();
  const pendingPdf =
    library.pendingPdfImport?.noteId === noteId
      ? library.pendingPdfImport.file
      : undefined;
  const practice = usePracticeSession(noteId);

  const handleOperations = useCallback((operations: SyncOperation[]) => {
    void enqueueObjectMutations(operations)
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
    <>
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
          {...(pendingPdf
            ? {
                importedPdf: pendingPdf,
                onPdfImported: () => library.clearPendingPdfImport(noteId),
              }
            : {})}
          onOperations={handleOperations}
          focusPage={
            practice.session !== null ? focusPageIndex(practice.session) : null
          }
        />
      </div>
      {practice.session !== null ? (
        <PracticeBar
          key={practice.session.id}
          session={practice.session}
          onSessionChange={practice.apply}
          onRefresh={practice.refresh}
        />
      ) : null}
    </>
  );
}
