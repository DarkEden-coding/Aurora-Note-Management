// Verifies the OpenAI device-login start contract and actionable upstream errors.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDeviceAuth } from "../src/ai/oauth.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("startDeviceAuth", () => {
  it("returns the OpenAI verification page and device code", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_auth_id: "device-1",
          user_code: "ABCD-EFGH",
          interval: "5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(startDeviceAuth()).resolves.toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      deviceAuthId: "device-1",
      interval: 5,
    });
  });

  it("explains OpenAI challenge blocks", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 403 }));

    await expect(startDeviceAuth()).rejects.toThrow(
      "OpenAI blocked device login. Retry in your regular browser or from another network.",
    );
  });
});
