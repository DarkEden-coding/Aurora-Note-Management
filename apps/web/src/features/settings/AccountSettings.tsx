// This module is Aurora's account settings drawer: theme token selection across the three dark sets, device identity, session label, logout, and passkey-reset guidance.
import { LogOut, KeyRound, X, Sparkles } from "lucide-react";
import { THEMES, useTheme } from "../../theme/ThemeProvider.js";
import { getDeviceId } from "../../lib/id.js";
import { logout } from "../auth/session.js";
import { useEffect, useState } from "react";
import type { AiAuthStatus } from "@aurora/shared";
import * as chatApi from "../chat/api.js";

export function AccountSettings({
  userLabel,
  onLoggedOut,
  onClose,
}: {
  userLabel: string | null;
  onLoggedOut: () => void;
  onClose: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const deviceId = getDeviceId();
  const [aiAuth, setAiAuth] = useState<AiAuthStatus | null>(null);
  const [device, setDevice] = useState<{
    verificationUrl: string;
    userCode: string;
    deviceAuthId: string;
    interval: number;
  } | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  useEffect(() => {
    void chatApi
      .getAiAuthStatus()
      .then(setAiAuth)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const result = await chatApi.pollDeviceAuth(
          device.deviceAuthId,
          device.userCode,
        );
        if (cancelled) return;
        if (result.status === "connected") {
          setDevice(null);
          setAiAuth(await chatApi.getAiAuthStatus());
        }
      } catch (error) {
        if (!cancelled) {
          setDeviceError(
            error instanceof Error ? error.message : "Login failed",
          );
          setDevice(null);
        }
      }
    };
    const timer = window.setInterval(
      () => void tick(),
      (device.interval + 1) * 1000,
    );
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [device]);

  return (
    <div
      className="drawer panel"
      role="dialog"
      aria-modal="true"
      aria-label="Account settings"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="drawer-header">
        <div>
          <span className="eyebrow">Preferences</span>
          <h2>Account</h2>
        </div>
        <button
          className="icon-button ghost"
          onClick={onClose}
          aria-label="Close account settings"
        >
          <X size={17} />
        </button>
      </div>

      <div className="settings-row">
        <span>Theme</span>
        <div className="theme-options">
          {THEMES.map((candidate) => (
            <button
              key={candidate}
              className={candidate === theme ? "selected" : ""}
              onClick={() => setTheme(candidate)}
            >
              <span
                className={`theme-swatch ${candidate}`}
                aria-hidden="true"
              />
              <span>{candidate}</span>
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

      <div className="settings-row">
        <span>
          <Sparkles size={14} style={{ verticalAlign: "-2px" }} /> ChatGPT
        </span>
        <span className="description">
          {aiAuth?.connected
            ? aiAuth.mode === "api-key"
              ? "Using OPENAI_API_KEY"
              : (aiAuth.email ?? "Connected")
            : "Not connected"}
        </span>
      </div>
      {device ? (
        <p className="description">
          Open{" "}
          <a href={device.verificationUrl} target="_blank" rel="noreferrer">
            {device.verificationUrl}
          </a>{" "}
          and enter <strong>{device.userCode}</strong>
        </p>
      ) : null}
      {deviceError ? (
        <p className="error-text" role="alert">
          {deviceError}
        </p>
      ) : null}
      {aiAuth?.connected && aiAuth.mode === "chatgpt" ? (
        <button
          type="button"
          className="ghost"
          onClick={() => {
            void chatApi
              .disconnectAiAuth()
              .then(() => setAiAuth({ connected: false, mode: "none" }));
          }}
        >
          Disconnect ChatGPT
        </button>
      ) : (
        <button
          type="button"
          className="ghost"
          disabled={device !== null}
          onClick={() => {
            setDeviceError(null);
            window.open(
              "https://auth.openai.com/codex/device",
              "_blank",
              "noopener,noreferrer",
            );
            void chatApi
              .startDeviceAuth()
              .then(setDevice)
              .catch((error: unknown) =>
                setDeviceError(
                  error instanceof Error
                    ? error.message
                    : "Could not start login",
                ),
              );
          }}
        >
          Connect ChatGPT
        </button>
      )}

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
