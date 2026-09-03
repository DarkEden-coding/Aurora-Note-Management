// This screen signs the user in with a registered passkey: it fetches assertion options from the server's login-options route, collects the WebAuthn assertion, and posts it to the matching login-verify route. A "no passkey enrolled" answer routes to setup-token enrollment.
import { useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";
import { ApiError, api, apiPost } from "../../lib/http.js";
import {
  assertPasskey,
  webauthnSupported,
  type PublicKeyCredentialRequestOptionsJSON,
} from "../../lib/webauthn.js";

interface LoginVerifyResponse {
  authenticated: boolean;
  enrolled: boolean;
  credentialId: string;
}

interface LoginOptionsResponse {
  ceremonyId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}

export function LoginScreen({
  onLoggedIn,
  onEnrollRequired,
}: {
  onLoggedIn: () => void;
  onEnrollRequired: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!webauthnSupported())
      setError("This browser does not support passkeys (WebAuthn).");
  }, []);

  const login = async () => {
    setBusy(true);
    setError(null);
    try {
      // Options and verify are a matched pair on the server: the options request stores
      // the challenge, the verify request consumes it.
      const ceremony = await api<LoginOptionsResponse>(
        "/api/auth/passkeys/login/options",
      );
      const assertion = await assertPasskey(ceremony.options);
      await apiPost<LoginVerifyResponse>("/api/auth/passkeys/login", {
        ceremonyId: ceremony.ceremonyId,
        response: assertion,
      });
      onLoggedIn();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        // No passkey enrolled yet: first-time setup must run.
        onEnrollRequired();
        return;
      }
      setError(
        cause instanceof Error ? cause.message : "Passkey sign-in failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card panel">
        <h1>
          <Fingerprint size={18} style={{ verticalAlign: "-3px" }} /> Aurora
        </h1>
        <p>
          Sign in with your passkey. Nothing to type — the key stays on this
          device.
        </p>
        {error ? <div className="error-text">{error}</div> : null}
        <button
          className="primary"
          disabled={busy || !webauthnSupported()}
          onClick={() => void login()}
        >
          {busy ? "Waiting for authenticator…" : "Sign in with passkey"}
        </button>
        <p>
          No passkey on this device? Use the server's setup token to enroll one.
        </p>
      </div>
    </div>
  );
}
