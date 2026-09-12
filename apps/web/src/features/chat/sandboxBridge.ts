// Srcdoc sandbox: theme tokens, html2canvas screenshot, click/type/eval via postMessage.
import type { HtmlAct } from "@aurora/shared";
import html2canvasSource from "html2canvas/dist/html2canvas.min.js?raw";

const HOST = "aurora-host";
const SANDBOX = "aurora-sandbox";
const TIMEOUT_MS = 10_000;

export function themeVarsFrom(
  element: HTMLElement = document.documentElement,
): string {
  const style = getComputedStyle(element);
  const names = [
    "--bg",
    "--text",
    "--text-muted",
    "--accent",
    "--surface",
    "--radius",
    "--font",
    "--border",
    "--bg-raised",
  ];
  return names
    .map((name) => `${name}: ${style.getPropertyValue(name).trim()};`)
    .join(" ");
}

export function buildSrcdoc(html: string, themeCss: string): string {
  const themeStyle = `:root { ${themeCss} } html,body{margin:0;min-height:100%;background:var(--bg,#151820);color:var(--text,#f1f3f8);font-family:var(--font,sans-serif);}`;
  const canvasSource = html2canvasSource.replace(/<\/script/gi, "<\\/script");
  const bridge = `<script>${canvasSource}</script><script>${BRIDGE_SOURCE}</script>`;
  if (/<html[\s>]/i.test(html)) {
    let doc = html;
    if (/<head[\s>]/i.test(doc)) {
      doc = doc.replace(
        /<head[^>]*>/i,
        (match) => `${match}<style>${themeStyle}</style>`,
      );
    } else {
      doc = doc.replace(
        /<html[^>]*>/i,
        (match) => `${match}<head><style>${themeStyle}</style></head>`,
      );
    }
    if (/<\/body>/i.test(doc))
      return doc.replace(/<\/body>/i, `${bridge}</body>`);
    return `${doc}${bridge}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${themeStyle}</style></head><body>${html}${bridge}</body></html>`;
}

const BRIDGE_SOURCE = `
(function () {
  var errors = [];
  window.addEventListener("error", function (event) {
    errors.push(String(event.message || event.error || "error"));
  });
  window.addEventListener("unhandledrejection", function (event) {
    errors.push(String(event.reason || "rejection"));
  });
  function takeErrors() {
    var copy = errors.slice();
    errors.length = 0;
    return copy;
  }
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  async function capture() {
    var target = document.documentElement;
    if (window.html2canvas) {
      var canvas = await window.html2canvas(target, { backgroundColor: null, scale: 1, useCORS: true });
      return canvas.toDataURL("image/png");
    }
    throw new Error("html2canvas missing");
  }
  async function act(action) {
    if (action.click) {
      var clicked = document.querySelector(action.click);
      if (clicked) clicked.click();
      return;
    }
    if (action.type) {
      var field = document.querySelector(action.type.selector);
      if (!field) return;
      field.focus();
      if ("value" in field) field.value = action.type.text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (action.eval) {
      (0, eval)(action.eval);
    }
  }
  window.addEventListener("message", async function (event) {
    var data = event.data;
    if (!data || data.source !== "${HOST}") return;
    try {
      if (data.type === "act") {
        for (var i = 0; i < (data.actions || []).length; i++) await act(data.actions[i]);
        if (data.waitMs) await sleep(data.waitMs);
      }
      var png = await capture();
      event.source.postMessage({ source: "${SANDBOX}", id: data.id, ok: true, png: png, errors: takeErrors() }, "*");
    } catch (error) {
      event.source.postMessage({ source: "${SANDBOX}", id: data.id, ok: false, error: String(error) }, "*");
    }
  });
})();
`;

export type SandboxResult = { screenshot: string; errors: string[] };

export function callSandbox(
  iframe: HTMLIFrameElement,
  payload:
    | { type: "screenshot" }
    | { type: "act"; actions: HtmlAct[]; waitMs?: number },
): Promise<SandboxResult> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Sandbox command timed out"));
    }, TIMEOUT_MS);
    function onMessage(event: MessageEvent) {
      const data = event.data as {
        source?: string;
        id?: string;
        ok?: boolean;
        png?: string;
        errors?: string[];
        error?: string;
      };
      if (data?.source !== SANDBOX || data.id !== id) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (!data.ok || !data.png) {
        reject(new Error(data.error || "Sandbox command failed"));
        return;
      }
      resolve({ screenshot: data.png, errors: data.errors ?? [] });
    }
    window.addEventListener("message", onMessage);
    iframe.contentWindow?.postMessage({ source: HOST, id, ...payload }, "*");
  });
}
