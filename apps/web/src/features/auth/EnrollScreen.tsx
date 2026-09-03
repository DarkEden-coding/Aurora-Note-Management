// This screen runs Aurora's first-time enrollment: the one-time setup token is exchanged for an authenticated temporary session, then WebAuthn creation options are fetched from that session, a passkey is created with the platform authenticator, and registration is verified server-side.
import { useState } from "react";
import { KeyRound } from "lucide-react";
import { api, apiPost } from "../../lib/http.js";
import {
  createPasskey,
  webauthnSupported,
  type PublicKeyCredentialCreationOptionsJSON,
} from "../../lib/webauthn.js";

interface EnrollOptionsResponse {
  ceremonyId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}

interface EnrollVerifyResponse {
  authenticated: boolean;
  enrolled: boolean;
  credentialId: string;
}

export function EnrollScreen({ onEnrolled }: { onEnrolled: () => void }) {
  const [token, setToken] = useState("");
  const [deviceName, setDeviceName] = useState("Desktop Chrome");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!webauthnSupported()) {
    return (
      <div className="auth-screen">
        <div className="auth-card panel">
          <h1>Setup</h1>
          <p>
            This browser does not support passkeys (WebAuthn). Use a recent
            Chrome with a platform authenticator.
          </p>
        </div>
      </div>
    );
  }

  const enroll = async () => {
    setBusy(true);
    setError(null);
    try {
      // Step 1: the single-use setup token establishes a temporary authenticated session.
      await apiPost("/api/auth/setup/verify", { setupToken: token.trim() });
      // Step 2: passkey registration under that session (options come straight from the server).
      const ceremony = await api<EnrollOptionsResponse>(
        "/api/auth/passkeys/options",
      );
      const credential = await createPasskey(ceremony.options);
      // Step 3: verify the attestation; the session is now fully enrolled.
      await apiPost<EnrollVerifyResponse>("/api/auth/passkeys", {
        ceremonyId: ceremony.ceremonyId,
        response: credential,
        name: deviceName.trim() || undefined,
      });
      onEnrolled();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Enrollment failed. Check the setup token.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card panel">
        <h1>
          <KeyRound size={18} style={{ verticalAlign: "-3px" }} /> Set up Aurora
        </h1>
        <p>
          Enter the one-time setup token from the server, then create a passkey.
          The token is single-use and the passkey becomes your sign-in.
        </p>
        <div className="field">
          <label htmlFor="setup-token">Setup token</label>
          <input
            id="setup-token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="One-time bootstrap token"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="device-name">Device name</label>
          <input
            id="device-name"
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
          />
        </div>
        {error ? <div className="error-text">{error}</div> : null}
        <button
          className="primary"
          disabled={busy || token.trim().length === 0}
          onClick={() => void enroll()}
        >
          {busy ? "Creating passkey…" : "Create passkey"}
        </button>
        <p>
          Lost access? Regenerate the setup token on the server with the reset
          command and enroll again.
        </p>
      </div>
    </div>
  );
}
