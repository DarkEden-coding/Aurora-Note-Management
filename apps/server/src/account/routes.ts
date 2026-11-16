// Owner account routes: the boot-time account read plus the theme and drawing-palette mirrors.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { drawingPaletteSchema, themeSchema } from "@aurora/shared";
import { query } from "../db/pool.js";
import { ownerPreHandler } from "./owner.js";

const themeBodySchema = z.object({ theme: themeSchema });
const drawingPaletteBodySchema = z.object({
  // A PATCH must name the field; the shared default is only for absent legacy rows.
  drawingPalette: drawingPaletteSchema.unwrap(),
});

export function registerAccountRoutes(app: FastifyInstance): void {
  const preHandler = ownerPreHandler();

  app.get("/api/account", { preHandler }, async (request) => {
    const owner = await query<{ theme: string; drawingPalette: unknown }>(
      `SELECT theme, drawing_palette AS "drawingPalette"
       FROM users WHERE id = $1`,
      [request.ownerId!],
    );
    const theme = themeSchema.safeParse(owner.rows[0]?.theme);
    const drawingPalette = drawingPaletteSchema.safeParse(
      owner.rows[0]?.drawingPalette,
    );
    return {
      ownerId: request.ownerId,
      theme: theme.success ? theme.data : "neomorphic",
      drawingPalette: drawingPalette.success
        ? drawingPalette.data
        : ["#000000"],
    };
  });

  // Account-level theme mirror; local-first on the client, converged via the account read.
  app.patch("/api/account/theme", { preHandler }, async (request) => {
    const { theme } = themeBodySchema.parse(request.body);
    await query("UPDATE users SET theme = $2 WHERE id = $1", [
      request.ownerId!,
      theme,
    ]);
    return { theme };
  });

  // Ordered account palette, shared by every device via the account read.
  app.patch("/api/account/drawing-palette", { preHandler }, async (request) => {
    const { drawingPalette } = drawingPaletteBodySchema.parse(request.body);
    await query("UPDATE users SET drawing_palette = $2::jsonb WHERE id = $1", [
      request.ownerId!,
      JSON.stringify(drawingPalette),
    ]);
    return { drawingPalette };
  });
}
