// The Android app's scanner page: the web app's own ScanDialog (camera, edge detection, corner
// review and flattening), run in a WebView. The finished JPEG goes back to the app through
// window.AuroraScan. Built into the Android assets by vite.native-scan.config.ts (npm run build:native).
import { createRoot } from "react-dom/client";
import "../../styles/base.css";
import { ScanDialog } from "../../features/scan/ScanDialog";

declare global {
  interface Window {
    AuroraScan?: {
      scanned(name: string, base64Jpeg: string): void;
      close(): void;
    };
  }
}

/** Base64 of a file's bytes, for the string-only JavaScript bridge. */
async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// ScanDialog closes right after reporting a scan, so closing waits until the scan has been handed over.
let delivering: Promise<void> = Promise.resolve();

createRoot(root).render(
  <ScanDialog
    onScanned={(file) => {
      delivering = toBase64(file).then((data) =>
        window.AuroraScan?.scanned(file.name, data),
      );
    }}
    onClose={() => {
      void delivering.finally(() => window.AuroraScan?.close());
    }}
  />,
);
