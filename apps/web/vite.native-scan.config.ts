// Builds the Android app's document scanner page (src/native/scan) into the app's assets. The
// WebView serves it from https://appassets.androidplatform.net, a secure origin, so the camera,
// module workers and relative asset URLs work as on the web.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: "src/native/scan",
  base: "./",
  publicDir: false,
  build: {
    outDir: "../../../../android/app/src/main/assets/scan",
    emptyOutDir: true,
  },
});
