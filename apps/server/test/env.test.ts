// Unit tests for Aurora's server environment loader: defaults, failure modes, and production WebAuthn checks.
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";
import { sessionCookieOptions } from "../src/auth/sessions.js";

const baseEnv = {
  DATABASE_URL: "postgres://aurora:aurora@localhost:5432/aurora",
  AURORA_COOKIE_SECRET: "0123456789012345678901234567890123",
  AURORA_RP_ID: "localhost",
  AURORA_ORIGIN: "http://localhost:8787",
};

describe("loadEnv", () => {
  it("applies defaults for development", () => {
    const env = loadEnv(baseEnv);
    expect(env.NODE_ENV).toBe("development");
    expect(env.AURORA_PORT).toBe(8787);
    expect(env.AURORA_SESSION_TTL_DAYS).toBe(30);
    expect(env.AURORA_MAX_UPLOAD_BYTES).toBe(26_214_400);
    expect(env.AURORA_TRASH_RETENTION_DAYS).toBe(30);
    expect(env.AURORA_SNAPSHOT_RETENTION_DAYS).toBe(30);
    expect(env.AURORA_OPERATION_RETENTION_DAYS).toBe(30);
    expect(env.AURORA_SESSION_RETENTION_DAYS).toBe(30);
  });

  it("uses second-based cookie lifetime and allows local HTTP", () => {
    const env = loadEnv(baseEnv);
    expect(sessionCookieOptions(env).maxAge).toBe(30 * 86_400);
    expect(sessionCookieOptions(env).secure).toBe(false);
    expect(sessionCookieOptions(env).signed).toBe(true);
  });

  it("resolves the upload directory to an absolute path", () => {
    const env = loadEnv({ ...baseEnv, AURORA_UPLOAD_DIR: ".data/uploads" });
    expect(env.AURORA_UPLOAD_DIR.includes(".data/uploads")).toBe(true);
    expect(env.AURORA_UPLOAD_DIR.startsWith("/")).toBe(true);
  });

  it("rejects a short cookie secret", () => {
    expect(() =>
      loadEnv({ ...baseEnv, AURORA_COOKIE_SECRET: "too-short" }),
    ).toThrow(/AURORA_COOKIE_SECRET/);
  });

  it("rejects a non-numeric port", () => {
    expect(() => loadEnv({ ...baseEnv, AURORA_PORT: "not-a-port" })).toThrow(
      /AURORA_PORT/,
    );
  });

  it("rejects production origins where the RP ID is not a domain suffix", () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: "production",
        AURORA_RP_ID: "example.com",
        AURORA_ORIGIN: "https://aurora.other.org",
      }),
    ).toThrow(/AURORA_RP_ID/);
  });

  it("rejects public production origins without HTTPS", () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: "production",
        AURORA_RP_ID: "example.com",
        AURORA_ORIGIN: "http://aurora.example.com",
      }),
    ).toThrow(/HTTPS/);
  });

  it("accepts production origins where the host is a subdomain of the RP ID", () => {
    const env = loadEnv({
      ...baseEnv,
      NODE_ENV: "production",
      AURORA_RP_ID: "example.com",
      AURORA_ORIGIN: "https://aurora.example.com",
    });
    expect(env.NODE_ENV).toBe("production");
  });
});
