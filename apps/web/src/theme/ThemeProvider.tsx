// This module owns Aurora's theme token selection: it persists the account-level choice of the three dark token sets locally, mirrors it to the server (PATCH /api/account/theme), adopts the account theme on devices without a local choice, and applies it via the data-theme attribute. Tokens affect presentation only.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Theme } from "@aurora/shared";
import { apiPatch } from "../lib/http.js";

const STORAGE_KEY = "aurora.theme";
export const THEMES: Theme[] = ["neomorphic", "glass", "minimal"];

function readInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return THEMES.includes(stored as Theme) ? (stored as Theme) : "neomorphic";
}

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  // Account theme convergence: adopt the server's theme once per session when
  // this device has no stored choice (dispatched by the session check).
  useEffect(() => {
    const onServerTheme = (event: Event): void => {
      const next = (event as CustomEvent<Theme>).detail;
      if (THEMES.includes(next)) setThemeState(next);
    };
    window.addEventListener("aurora:server-theme", onServerTheme);
    return () =>
      window.removeEventListener("aurora:server-theme", onServerTheme);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    // Mirror to the account so other devices converge; failure is non-fatal offline.
    void apiPatch("/api/account/theme", { theme: next }).catch(() => undefined);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
