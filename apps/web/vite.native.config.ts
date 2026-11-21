// Builds the Android app's offscreen renderer (src/native/renderObject.ts) as one classic script
// plus stylesheet, so a WebView can load it from file:///android_asset without module CORS rules.
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "../android/app/src/main/assets/render/lib",
    emptyOutDir: true,
    lib: {
      entry: "src/native/renderObject.ts",
      formats: ["iife"],
      name: "AuroraRenderer",
      fileName: () => "render.js",
      cssFileName: "render",
    },
  },
});
