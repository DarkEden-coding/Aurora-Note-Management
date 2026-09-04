// Guards Aurora's installability contract and verifies the generated icon dimensions.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type ManifestIcon = {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
};
type Manifest = {
  id: string;
  start_url: string;
  scope: string;
  display: string;
  display_override: string[];
  icons: ManifestIcon[];
};

const publicDirectory = resolve(import.meta.dirname, "../public");
const manifest = JSON.parse(
  readFileSync(resolve(publicDirectory, "manifest.webmanifest"), "utf8"),
) as Manifest;

function pngDimensions(path: string) {
  const image = readFileSync(path);
  expect(image.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

describe("PWA assets", () => {
  it("declares a scoped fullscreen application", () => {
    expect(manifest).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "fullscreen",
    });
    expect(manifest.display_override).toContain("standalone");
  });

  it.each(manifest.icons)("ships $sizes $purpose icon", (icon) => {
    expect(icon.type).toBe("image/png");
    const expectedSize = Number(icon.sizes.split("x")[0]);
    expect(pngDimensions(resolve(publicDirectory, icon.src.slice(1)))).toEqual({
      width: expectedSize,
      height: expectedSize,
    });
  });
});
