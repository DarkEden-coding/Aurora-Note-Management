// Aurora has no login, so the origin guard is what stops other sites from using the owner's browser.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { loadEnv } from "../src/env.js";

const ORIGIN = "https://aurora.example.ts.net:8443";

describe("origin guard", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://aurora:aurora@localhost:5432/aurora",
      AURORA_ORIGIN: ORIGIN,
    });
    app = await buildServer(env);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects writes and socket upgrades from another site", async () => {
    const write = await app.inject({
      method: "POST",
      url: "/api/sync/operations",
      headers: { origin: "https://evil.example" },
      payload: {},
    });
    expect(write.statusCode).toBe(403);

    const upgrade = await app.inject({
      method: "GET",
      url: "/sync/ws",
      headers: { origin: "https://evil.example" },
    });
    expect(upgrade.statusCode).toBe(403);
  });

  it("rejects an opaque null origin", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: "null" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("allows Aurora's own origin and requests without one", async () => {
    const sameOrigin = await app.inject({
      method: "GET",
      url: "/healthz",
      headers: { origin: ORIGIN },
    });
    expect(sameOrigin.statusCode).toBe(200);

    const noOrigin = await app.inject({ method: "GET", url: "/healthz" });
    expect(noOrigin.statusCode).toBe(200);
  });
});
