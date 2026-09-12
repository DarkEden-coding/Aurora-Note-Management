// Live HTML sandbox the agent iterates: render, screenshot, click/type/eval.
import { useImperativeHandle, useRef, useState, forwardRef } from "react";
import type { HtmlAct } from "@aurora/shared";
import {
  buildSrcdoc,
  callSandbox,
  themeVarsFrom,
  type SandboxResult,
} from "./sandboxBridge.js";

export type HtmlWorkbenchHandle = {
  render: (html: string) => Promise<SandboxResult>;
  act: (actions: HtmlAct[], waitMs?: number) => Promise<SandboxResult>;
  html: () => string | null;
};

export const HtmlWorkbench = forwardRef<
  HtmlWorkbenchHandle,
  { visible?: boolean }
>(function HtmlWorkbench({ visible = true }, ref) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const htmlRef = useRef<string | null>(null);
  const [active, setActive] = useState(false);

  useImperativeHandle(ref, () => ({
    html: () => htmlRef.current,
    render: (html: string) => {
      htmlRef.current = html;
      const iframe = iframeRef.current;
      if (!iframe) return Promise.reject(new Error("Workbench iframe missing"));
      const next = buildSrcdoc(html, themeVarsFrom());
      setActive(true);
      return new Promise<SandboxResult>((resolve, reject) => {
        const onLoad = () => {
          iframe.removeEventListener("load", onLoad);
          window.setTimeout(() => {
            callSandbox(iframe, { type: "screenshot" }).then(resolve, reject);
          }, 80);
        };
        iframe.addEventListener("load", onLoad);
        iframe.srcdoc = next;
      });
    },
    act: (actions, waitMs) => {
      const iframe = iframeRef.current;
      if (!iframe) return Promise.reject(new Error("Workbench iframe missing"));
      return callSandbox(iframe, {
        type: "act",
        actions,
        ...(waitMs !== undefined ? { waitMs } : {}),
      });
    },
  }));

  return (
    <iframe
      ref={iframeRef}
      className={`chat-workbench${visible && active ? "" : " parked"}`}
      title="HTML workbench"
      aria-hidden={!visible || !active}
      tabIndex={visible && active ? 0 : -1}
      sandbox="allow-scripts"
    />
  );
});
