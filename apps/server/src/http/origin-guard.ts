// Rejects cross-site browser requests. Aurora has no login, so without this check any page the
// owner visits could open /sync/ws or send writes from inside the tailnet. Browsers always send
// Origin on WebSocket upgrades and cross-origin writes; requests without one (curl, navigation,
// same-origin GETs) come from no foreign page and pass.
import type { FastifyInstance } from "fastify";
import type { AuroraEnv } from "../env.js";
import { DomainError } from "../errors.js";

export function isAllowedOrigin(
  originHeader: string | undefined,
  allowedOrigin: string,
): boolean {
  if (originHeader === undefined) return true;
  return originHeader === new URL(allowedOrigin).origin;
}

export function registerOriginGuard(
  app: FastifyInstance,
  env: AuroraEnv,
): void {
  app.addHook("onRequest", async (request) => {
    if (!isAllowedOrigin(request.headers.origin, env.AURORA_ORIGIN)) {
      throw new DomainError(
        403,
        "cross_origin",
        "Cross-origin request rejected",
      );
    }
  });
}
