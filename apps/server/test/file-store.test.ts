// Unit tests for Aurora's upload store helpers: digest paths, filename and MIME sanitization.
import { describe, expect, it } from "vitest";
import {
  absoluteFilePath,
  digestToRelativePath,
  sanitizeFilename,
  sanitizeMimeType,
} from "../src/files/store.js";

const validDigest = "a".repeat(64);
const upperDigest = "A".repeat(64);

describe("digestToRelativePath", () => {
  it("shards valid digests into two directory levels", () => {
    const digest = "ab" + "0".repeat(62);
    expect(digestToRelativePath(digest)).toBe("ab/00/" + digest);
  });

  it("rejects malformed digests", () => {
    expect(() => digestToRelativePath("../evil")).toThrow();
    expect(() => digestToRelativePath(upperDigest)).toThrow();
    expect(() => digestToRelativePath(validDigest.slice(1))).toThrow();
  });

  it("never produces path separators outside the shard scheme", () => {
    const relative = digestToRelativePath(validDigest);
    expect(relative.split("/")).toHaveLength(3);
  });
});

describe("absoluteFilePath", () => {
  it("stays inside the upload directory", () => {
    const p = absoluteFilePath("/data/uploads", validDigest);
    expect(p.startsWith("/data/uploads/")).toBe(true);
    expect(p.endsWith(validDigest)).toBe(true);
  });
});

describe("sanitizeFilename", () => {
  it("strips control characters, quotes, and separators", () => {
    expect(sanitizeFilename('re\r\nport"name\\x.pdf')).toBe("reportnamex.pdf");
  });

  it("falls back to 'file' for empty results", () => {
    expect(sanitizeFilename("...")).toBe("file");
    expect(sanitizeFilename("")).toBe("file");
  });

  it("caps the length at 128 characters", () => {
    expect(sanitizeFilename("x".repeat(500)).length).toBeLessThanOrEqual(128);
  });
});

describe("sanitizeMimeType", () => {
  it("keeps well-formed mime types and lowercases them", () => {
    expect(sanitizeMimeType("Image/PNG")).toBe("image/png");
    expect(sanitizeMimeType("application/pdf")).toBe("application/pdf");
  });

  it("falls back to application/octet-stream for malformed values", () => {
    expect(sanitizeMimeType("not a mime")).toBe("application/octet-stream");
    expect(sanitizeMimeType("")).toBe("application/octet-stream");
  });
});
