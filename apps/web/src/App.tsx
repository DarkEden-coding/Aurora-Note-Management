// This module composes Aurora's root flow: session check against the server cookie, enroll/login screens when unauthenticated, and the authenticated shell wrapped in the theme provider and library provider.
import { useState } from "react";
import { EnrollScreen } from "./features/auth/EnrollScreen.js";
import { LoginScreen } from "./features/auth/LoginScreen.js";
import { useSession } from "./features/auth/session.js";
import { LibraryProvider } from "./features/library/LibraryContext.js";
import { AuthenticatedShell } from "./shell/AuthenticatedShell.js";
import { ErrorBoundary } from "./shell/ErrorBoundary.js";

export function App() {
  const {
    state,
    ownerId,
    userLabel,
    drawingPalette,
    updateDrawingPalette,
    refresh,
  } = useSession();
  const [authView, setAuthView] = useState<"login" | "enroll">("login");

  if (state === "checking") {
    return <div className="auth-screen">Connecting…</div>;
  }

  if (state === "unauthenticated") {
    return authView === "enroll" ? (
      <EnrollScreen
        onEnrolled={() => {
          setAuthView("login");
          void refresh();
        }}
      />
    ) : (
      <LoginScreen
        onLoggedIn={() => void refresh()}
        onEnrollRequired={() => setAuthView("enroll")}
      />
    );
  }

  if (!ownerId) {
    return <div className="auth-screen">Session is missing its owner.</div>;
  }

  return (
    <LibraryProvider>
      <ErrorBoundary label="workspace">
        <AuthenticatedShell
          ownerId={ownerId}
          userLabel={userLabel}
          drawingPalette={drawingPalette}
          onDrawingPaletteChange={updateDrawingPalette}
          onLoggedOut={() => {
            setAuthView("login");
            void refresh();
          }}
        />
      </ErrorBoundary>
    </LibraryProvider>
  );
}
