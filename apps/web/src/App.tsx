// This module composes Aurora's root flow: load the owner account, show a reconnect screen when the server is unreachable, and otherwise render the workspace shell inside the library provider.
import { useAccount } from "./features/account/account.js";
import { LibraryProvider } from "./features/library/LibraryContext.js";
import { WorkspaceShell } from "./shell/WorkspaceShell.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.js";

export function App() {
  const { state, ownerId, drawingPalette, updateDrawingPalette, refresh } =
    useAccount();

  if (state === "loading") {
    return <div className="status-screen">Connecting…</div>;
  }

  if (state === "unreachable" || !ownerId) {
    return (
      <div className="status-screen">
        <div className="status-card panel">
          <h1>Can't reach Aurora</h1>
          <p>
            Aurora is only available inside your tailnet. Check that Tailscale
            is connected on this device, then try again.
          </p>
          <button className="primary" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <LibraryProvider>
      <ErrorBoundary label="workspace">
        <WorkspaceShell
          ownerId={ownerId}
          drawingPalette={drawingPalette}
          onDrawingPaletteChange={updateDrawingPalette}
        />
      </ErrorBoundary>
    </LibraryProvider>
  );
}
