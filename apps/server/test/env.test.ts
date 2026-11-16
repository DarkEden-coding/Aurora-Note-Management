// Unit tests for Aurora's server environment loader: defaults, failure modes, and production origin checks.
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

const baseEnv = {
  DATABASE_URL: "postgres://aurora:aurora@localhost:5432/aurora",
  AURORA_ORIGIN: "http://localhost:8787",
};

describe("loadEnv", () => {
  it("applies defaults for development", () => {
    const env = loadEnv(baseEnv);
    expect(env.NODE_ENV).toBe("development");
    expect(env.AURORA_PORT).toBe(8787);
    expect(env.AURORA_MAX_UPLOAD_BYTES).toBe(26_214_400);
    expect(env.AURORA_TRASH_RETENTION_DAYS).toBe(30);
    expect(env.AURORA_SNAPSHOT_RETENTION_DAYS).toBe(30);
    expect(env.AURORA_OPERATION_RETENTION_DAYS).toBe(30);
  });

  it("resolves the upload directory to an absolute path", () => {
    const env = loadEnv({ ...baseEnv, AURORA_UPLOAD_DIR: ".data/uploads" });
    expect(env.AURORA_UPLOAD_DIR.includes(".data/uploads")).toBe(true);
    expect(env.AURORA_UPLOAD_DIR.startsWith("/")).toBe(true);
  });

  it("rejects a non-numeric port", () => {
    expect(() => loadEnv({ ...baseEnv, AURORA_PORT: "not-a-port" })).toThrow(
      /AURORA_PORT/,
    );
  });

  it("rejects public production origins without HTTPS", () => {
    expect(() =>
      loadEnv({
        ...baseEnv,
        NODE_ENV: "production",
        AURORA_ORIGIN: "http://aurora.example.com",
      }),
    ).toThrow(/HTTPS/);
  });

  it("accepts HTTPS production origins", () => {
    const env = loadEnv({
      ...baseEnv,
      NODE_ENV: "production",
      AURORA_ORIGIN: "https://aurora.example.com",
    });
    expect(env.NODE_ENV).toBe("production");
  });
});
