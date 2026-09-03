// This module is Aurora's account settings drawer: theme token selection across the three dark sets, device identity, session label, logout, and passkey-reset guidance.
import { LogOut, KeyRound } from "lucide-react";
import { THEMES, useTheme } from "../../theme/ThemeProvider.js";
import { getDeviceId } from "../../lib/id.js";
import { logout } from "../auth/session.js";

export function AccountSettings({
  userLabel,
  onLoggedOut,
}: {
  userLabel: string | null;
  onLoggedOut: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const deviceId = getDeviceId();

  return (
    <div className="drawer" role="dialog" aria-label="Account settings">
      <h2>Account</h2>

      <div className="settings-row">
        <span>Theme</span>
        <div className="theme-options">
          {THEMES.map((candidate) => (
            <button
              key={candidate}
              className={candidate === theme ? "selected" : ""}
              onClick={() => setTheme(candidate)}
            >
              {candidate}
            </button>
          ))}
        </div>
      </div>
      <p className="description" style={{ margin: 0 }}>
        Theme tokens change presentation only; canvas geometry never depends on
        them.
      </p>

      <dl className="kv">
        <dt>Signed in</dt>
        <dd>{userLabel ?? "Passkey owner"}</dd>
        <dt>Device ID</dt>
        <dd>{deviceId}</dd>
      </dl>

      <div className="settings-row">
        <span>
          <KeyRound size={14} style={{ verticalAlign: "-2px" }} /> Passkeys
        </span>
        <span className="description">
          Manage on each device; lost access is recovered with a fresh setup
          token.
        </span>
      </div>

      <button
        onClick={() => {
          void logout()
            .catch(() => undefined)
            .finally(() => onLoggedOut());
        }}
      >
        <LogOut size={14} style={{ verticalAlign: "-2px" }} /> Sign out
      </button>
    </div>
  );
}
