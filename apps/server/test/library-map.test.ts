// Unit tests for Aurora's tolerant background reader and session-token primitives.
import { describe, expect, it } from "vitest";
import { DEFAULT_BACKGROUND, mergeBackground } from "../src/library/map.js";
import { createSessionToken, hashSessionToken } from "../src/auth/sessions.js";

describe("mergeBackground", () => {
  it("accepts a complete shared-contract background", () => {
    const background = mergeBackground({
      pattern: "dot-grid",
      color: "#101010",
      patternColor: "#2a2a2a",
      spacing: 32,
    });
    expect(background).toEqual({
      pattern: "dot-grid",
      color: "#101010",
      patternColor: "#2a2a2a",
      spacing: 32,
    });
  });

  it("fills missing fields with defaults for legacy '{}' rows", () => {
    expect(mergeBackground({})).toEqual(DEFAULT_BACKGROUND);
    expect(mergeBackground(null)).toEqual(DEFAULT_BACKGROUND);
  });

  it("keeps valid fields and drops invalid ones", () => {
    const background = mergeBackground({
      pattern: "ruled",
      spacing: 9999,
      color: 42,
    });
    expect(background.pattern).toBe("ruled");
    expect(background.spacing).toBe(DEFAULT_BACKGROUND.spacing);
    expect(background.color).toBe(DEFAULT_BACKGROUND.color);
  });
});

describe("session token primitives", () => {
  it("hashes tokens deterministically with sha256", () => {
    expect(hashSessionToken("abc")).toBe(hashSessionToken("abc"));
    expect(hashSessionToken("abc")).not.toBe(hashSessionToken("abd"));
    expect(hashSessionToken("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates base64url opaque tokens", () => {
    const { token, tokenHash } = createSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokenHash).toBe(hashSessionToken(token));
  });
});
